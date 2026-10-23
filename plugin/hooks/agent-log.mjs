#!/usr/bin/env node
// Claude Code adapter of the DevReceipt agent log (docs/AGENT-LOG.md). Runs after every Read, Edit, Write, MultiEdit,
// NotebookEdit and Bash call (PostToolUse, and PostToolUseFailure for calls that failed) and appends one line to a
// spool in the repository's git dir. It never writes to the working tree, never to stdout (JSON there could steer
// the session), never stores file contents, diffs or command output, and always exits 0.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync, existsSync, mkdirSync, writeFileSync, writeSync, rmSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export const SPOOL = 'devreceipt-spool.jsonl';
export const DEFAULT_TEST_PATTERNS = ['npm test', 'npm run test', 'pnpm test', 'pnpm run test', 'yarn test', 'yarn run test',
  'node --test', 'vitest', 'jest', 'pytest', 'go test', 'cargo test'];
// commands that check the code besides tests: kept verbatim (redacted like test commands) with their exit code
export const DEFAULT_CHECK_PATTERNS = {
  coverage: ['c8', 'nyc', 'jest --coverage', 'vitest --coverage', 'vitest run --coverage', 'pytest --cov', 'coverage run',
    'npm run coverage', 'npm run test:coverage', 'pnpm coverage', 'yarn coverage'],
  typecheck: ['tsc', 'vue-tsc', 'npm run typecheck', 'npm run type-check', 'npm run tsc', 'pnpm typecheck', 'yarn typecheck', 'mypy', 'pyright'],
  lint: ['eslint', 'npm run lint', 'pnpm lint', 'yarn lint', 'biome', 'ruff', 'flake8', 'golangci-lint'],
  build: ['npm run build', 'pnpm build', 'yarn build', 'vite build', 'next build', 'cargo build', 'go build', 'tsup'],
};
const FILE_TOOLS = { Read: 'file_path', Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };
// a flag whose value is a secret: one of these words as a part of its name, or contained in it
const SECRET_PART = new Set(['auth', 'key', 'apikey', 'pass', 'passwd', 'pwd', 'cred', 'pat', 'dsn', 'login', 'user', 'u', 'p', 'jwt']);
const SECRET_IN = /token|secret|passw|authoriz|credential|cookie|session|bearer|apikey|api-key|private/i;
const sensitiveFlag = (flag) => {
  const name = flag.replace(/^-+/, '').toLowerCase();
  return SECRET_IN.test(name) || name.split(/[-_.]/).some((part) => SECRET_PART.has(part));
};
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// commands that run the next word: package runners, env, time, and output filters like rtk that rewrite commands
const WRAPPERS = new Set(['npx', 'bunx', 'env', 'time', 'rtk']);

/**
 * A command line as simple commands, each a list of words with `sep`: the operator before it ('' for the first, or
 * && || | ; & newline or a parenthesis). Quotes and backslash escapes stay inside their word; redirections (2>&1,
 * >file, <<EOF) are dropped, and a here-document's body is skipped, so a file the agent writes is never read as
 * commands. Good enough to find where a command starts, not a shell parser.
 */
export function commands(cmd) {
  const out = [];
  let words = [];
  let sep = '';
  let word = '';
  let has = false;
  let quote = null;
  let redirect = false; // the next word is a redirection target ('out': of an output redirection)
  let writes = false; // an output redirection into a file (not /dev/null, not &N)
  const intoFile = (target) => target !== '' && target !== '/dev/null' && !/^&?\d*$/.test(target) && target !== '&-';
  let heredoc = null; // delimiter of a here-document whose body starts at the next newline
  const endWord = () => {
    if (has) {
      if (redirect) { if (redirect === 'out' && intoFile(word)) writes = true; redirect = false; }
      else if (/^\d*(<<-?|[<>]&?|>>|&>>?)/.test(word)) {
        const m = /^\d*<<-?\s*(['"]?)(.*?)\1$/.exec(word);
        if (m) { if (m[2]) heredoc = m[2]; else redirect = 'heredoc'; } // <<EOF, or << EOF with the delimiter next
        else if (/^\d*(>>?|<|&>>?)$/.test(word)) redirect = word.includes('>') ? 'out' : true; // "> file": the target is the next word
        else if (word.includes('>') && intoFile(word.replace(/^\d*&?>>?&?/, ''))) writes = true; // ">file", "2>err.log"
      } else words.push(word);
    }
    word = '';
    has = false;
  };
  const endCommand = (next) => {
    endWord();
    if (words.length) { words.sep = sep; out.push(words); }
    words = [];
    sep = next;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      word += c;
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) word += cmd[++i];
      continue;
    }
    if (c === '\\' && i + 1 < cmd.length) { word += c + cmd[++i]; has = true; continue; }
    if (c === '"' || c === "'") { quote = c; word += c; has = true; continue; }
    if (redirect === 'heredoc' && /\s/.test(c) && !has) continue;
    if (c === '\n') {
      if (redirect === 'heredoc') { heredoc = word.replace(/^(['"])(.*)\1$/, '$2'); redirect = false; word = ''; has = false; }
      endCommand('\n');
      if (heredoc) { // skip the body up to the line that is the delimiter
        const lines = cmd.slice(i + 1).split('\n');
        const n = lines.findIndex((l) => l.replace(/^\t+/, '') === heredoc);
        i += n < 0 ? cmd.length : lines.slice(0, n + 1).join('\n').length + 1;
        heredoc = null;
      }
      continue;
    }
    if (c === '<' || c === '>' || (c === '&' && (/[<>]$/.test(word) || cmd[i + 1] === '>'))) {
      if (!/^\d*$/.test(word) && !/[<>&]$/.test(word)) endWord(); // "x>y": the redirection starts a word of its own
      word += c; has = true;
      continue;
    }
    if (c === '&' || c === '|' || c === ';') {
      const op = (c === '&' || c === '|') && cmd[i + 1] === c ? (i++, c + c) : c;
      endCommand(op);
      continue;
    }
    if (c === '(' || c === ')') { endCommand(c); continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    word += c; has = true;
  }
  endCommand('');
  out.writes = writes;
  return out;
}

/** A command without its leading VAR=value assignments and wrappers (npx, bunx, env, time, rtk). */
function stripLead(words) {
  let i = 0;
  let wrapped = false; // flags right after a wrapper belong to it (npx --yes)
  while (i < words.length && (ASSIGNMENT.test(words[i]) || WRAPPERS.has(words[i]) || (wrapped && words[i].startsWith('-')))) {
    if (WRAPPERS.has(words[i])) wrapped = true;
    i++;
  }
  return { lead: words.slice(0, i), rest: words.slice(i) };
}

const usable = (patterns) => patterns.map((p) => p.trim().split(/\s+/)).filter((w) => w[0]);
/** The test pattern a simple command starts with, as its words, or null. */
function testPattern(words, patterns) {
  const { rest } = stripLead(words);
  return usable(patterns).find((p) => p.every((w, i) => (i === 0 ? path.basename(rest[0] ?? '') : rest[i]) === w)) ?? null;
}

/** Whether a command line runs tests: a test pattern at the start of one of its commands, not inside an argument. */
export function isTest(cmd, patterns = DEFAULT_TEST_PATTERNS) {
  return commands(cmd).some((c) => testPattern(c, patterns));
}

/** An argument kept as written: a relative path or file name, nothing that could carry a secret. */
const SUBCOMMANDS = new Set(['run', 'watch', 'test', 'tests', 'unit', 'e2e', 'integration', 'all', '--']);
// a run of 20 or more letters and digits looks like a token, unless it is words in camelCase (testProviderCredentials)
const wordy = (run) => /^(?:[A-Z]?[a-z]{2,}){2,}$/.test(run);
const harmless = (v) => SUBCOMMANDS.has(v) || /^\d{1,6}$/.test(v)
  || (/^[\w.*@+-]+(\/[\w.*@+-]*)*$/.test(v) && (v.includes('/') || /\.[A-Za-z]\w{0,5}$/.test(v)) && !(v.match(/[A-Za-z0-9]{20,}/g) ?? []).some((r) => !wordy(r)));

// flags that choose test files by a path pattern: their value is kept when it is one (no space, a / . or |, path and
// regex characters only, nothing token-like), so a later run can be matched to a failed one. Test names (-t, -k,
// --grep, --testNamePattern) are free text that may hold anything, and stay [REDACTED].
const SELECTING = /^--testPathPatterns?$/;
const unquote = (v) => (/^(['"]).*\1$/s.test(v) ? v.slice(1, -1) : v);
const pathLike = (u) => u.length <= 200 && /^[\w.*|()\[\]/\\^$?+-]+$/.test(u) && /[/.|]/.test(u) && !u.includes('$(') && !/^\$/.test(u)
  && !(u.match(/[A-Za-z0-9]{20,}/g) ?? []).some((r) => !wordy(r))
  // key prefixes, and long runs that mix letters and digits, the way generated keys do
  && !/(^|[^A-Za-z])(sk|pk|rk)[-_]|gh[pousr][-_]|github_pat_|xox[abpr]-|AKIA|eyJ/.test(u)
  && !(u.match(/[A-Za-z0-9_-]{16,}/g) ?? []).some((r) => /\d/.test(r) && /[A-Za-z]/.test(r));
const pattern = (v) => pathLike(unquote(v));

/**
 * What is stored of a test command: only the test command itself (never the rest of the line), its pattern, its flag
 * names and the relative paths it names. Assignments, values of secret-named flags, quoted strings and anything else
 * become [REDACTED]. A gap is better than a leak.
 */
export function testCommand(cmd, patterns = DEFAULT_TEST_PATTERNS) {
  for (const words of commands(cmd)) {
    const p = testPattern(words, patterns);
    if (!p) continue;
    const { lead, rest } = stripLead(words);
    const out = [...lead.map((w) => (WRAPPERS.has(w) || /^--?[a-z][a-z-]*$/.test(w) ? w : '[REDACTED]')), ...p];
    let secretNext = false;
    let selectNext = false;
    for (const a of rest.slice(p.length)) {
      const flag = /^(--?[A-Za-z][\w.-]*)(?:=(.*))?$/s.exec(a);
      if (flag && !secretNext && !selectNext) {
        const secret = sensitiveFlag(flag[1]);
        const select = !secret && SELECTING.test(flag[1]);
        out.push(flag[2] === undefined ? flag[1] : `${flag[1]}=${!secret && (harmless(flag[2]) || (select && pattern(flag[2]))) ? flag[2] : '[REDACTED]'}`);
        secretNext = secret && flag[2] === undefined;
        selectNext = select && flag[2] === undefined;
      } else {
        out.push(!secretNext && (harmless(a) || (selectNext && pattern(a))) ? a : '[REDACTED]');
        secretNext = false;
        selectNext = false;
      }
    }
    return out.join(' ');
  }
  return null;
}

/**
 * The exit code of the test command, where the line's exit code is the test's: the test command is the last command,
 * and everything before it is joined by && (or a parenthesis). Exit 0 then means every step ran and passed. A failure
 * belongs to the test only if every step before it was a cd. Otherwise (npm test; git status, npm test | tail) the
 * line's exit code says nothing about the test: null.
 */
export function testExit(cmd, patterns, exit) {
  const cs = commands(cmd);
  const i = cs.findIndex((w) => testPattern(w, patterns));
  if (i < 0 || exit == null || i !== cs.length - 1) return null;
  if (!cs.slice(1, i + 1).every((w) => w.sep === '&&' || w.sep === '(')) return null;
  return exit === 0 || cs.slice(0, i).every((w) => stripLead(w).rest[0] === 'cd') ? exit : null;
}

// commands that only read: a line made of these alone changes no file, so the before/after check is skipped
export const DEFAULT_READ_ONLY = ['ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'wc', 'pwd', 'echo', 'printf', 'which', 'cd',
  'git status', 'git log', 'git diff', 'git show'];

/**
 * Whether a command line can change no file: every command in it is on the read-only list, nothing is redirected into
 * a file, there is no command substitution, and no find -delete/-exec or git --output. Conservative: any doubt is no.
 */
export function readOnly(cmd, list = DEFAULT_READ_ONLY) {
  if (/`|\$\(/.test(cmd)) return false;
  const cs = commands(cmd);
  if (cs.writes || !cs.length) return false;
  const entries = usable(list);
  return cs.every((w) => {
    const { rest } = stripLead(w);
    const hit = entries.some((e) => e.every((x, i) => (i === 0 ? path.basename(rest[0] ?? '') : rest[i]) === x));
    if (!hit) return false;
    if (path.basename(rest[0]) === 'find' && rest.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a))) return false;
    if (path.basename(rest[0]) === 'git' && rest.some((a) => a.startsWith('--output') || a === '-o')) return false;
    return true;
  });
}

// git subcommands that only move between committed states: the files they change hold content already committed
const GIT_REPLAY = new Set(['rebase', 'merge', 'pull', 'cherry-pick', 'switch', 'stash', 'fetch', 'commit', 'add', 'branch', 'worktree', 'tag', 'push', 'status', 'log', 'diff', 'show']);
/**
 * A command line of git and read-only commands only: 'replay' when every git command only moves between committed
 * states (a rebase, its abort, a pull), 'other' for any other git command (checkout, reset, apply, revert), 'none' when
 * the line runs anything else.
 */
export function gitOnly(cmd, list = DEFAULT_READ_ONLY) {
  if (!readOnly(cmd, [...list, 'git'])) return 'none';
  const subs = commands(cmd).map((w) => stripLead(w).rest).filter((r) => path.basename(r[0] ?? '') === 'git').map((r) => {
    let i = 1;
    while (i < r.length && r[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree'].includes(r[i]) ? 2 : 1;
    return r[i];
  });
  return subs.length && subs.every((x) => GIT_REPLAY.has(x)) ? 'replay' : subs.length ? 'other' : 'none';
}

/** The program a command line starts with, as a bare name; [unknown] for anything that does not look like one. */
export function program(cmd) {
  const { rest } = stripLead(commands(cmd)[0] ?? []);
  const name = path.basename(rest[0] ?? '');
  return /^[A-Za-z][A-Za-z0-9.+-]{0,23}$/.test(name) && !(/\d/.test(name) && name.length > 12) ? name : '[unknown]';
}

/** The repository a path or folder belongs to: its working root, its own git dir (per worktree) and the shared one. */
export function repoOf(dir) {
  const [gitDir, commonDir, root] = gitRead(dir, ['rev-parse', '--absolute-git-dir', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], undefined, 3000).trim().split('\n');
  return { gitDir, commonDir, root: realpathSync(root) };
}

/** Spools of linked worktrees, in the shared git dir: git worktree remove deletes the worktree's own git dir. */
export const SPOOLS = 'devreceipt-spools';
const ID = 'devreceipt-id';

/**
 * Where a checkout's spool lives. The main checkout's git dir is the shared one. A linked worktree's spool is
 * <shared git dir>/devreceipt-spools/<id>.jsonl, the id kept in the worktree's own git dir: it goes with the worktree,
 * so a new worktree of the same name gets a spool of its own, and the old one is left over (orphanSpools).
 */
export function spoolPath(repo) {
  if (path.resolve(repo.gitDir) === path.resolve(repo.commonDir ?? repo.gitDir)) return path.join(repo.gitDir, SPOOL);
  const idFile = path.join(repo.gitDir, ID);
  let id = '';
  try { id = readFileSync(idFile, 'utf8').trim(); } catch { /* the first entry of this worktree */ }
  if (!id) {
    try { writeFileSync(idFile, `${path.basename(repo.gitDir)}-${randomBytes(4).toString('hex')}\n`, { flag: 'wx' }); } catch { /* another hook was first */ }
    id = readFileSync(idFile, 'utf8').trim();
  }
  const file = path.join(repo.commonDir, SPOOLS, `${id}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  // a spool from before it moved here (it lived in the worktree's own git dir); each line gets the branch checked out
  // when it was recorded, so it still finds it once the worktree is gone
  const branchAt = branchesOf(repo.gitDir);
  const stamp = (l) => { try { const e = JSON.parse(l); if (e.branch) return l; const b = branchAt(Date.parse(e.at)); return JSON.stringify(b.branch ? { ...e, ...b } : e); } catch { return l; } };
  for (const [old, now] of [[SPOOL, file], [`${SPOOL}.flushing`, `${file}.flushing`]]) {
    const o = path.join(repo.gitDir, old);
    if (!existsSync(o)) continue;
    const lines = readFileSync(o, 'utf8').split('\n').filter((l) => l.trim());
    if (lines.length) appendFileSync(now, `${lines.map(stamp).join('\n')}\n`);
    rmSync(o, { force: true });
  }
  return file;
}

/**
 * Spools still in a linked worktree's own git dir (from before they moved) go to the shared one now, on any hook call
 * of the repository: git worktree remove deletes that dir, and an idle worktree would never move its own. One being
 * committed right now (.flushing, under a minute old) is left to its flush.
 */
export function adoptWorktreeSpools(commonDir) {
  let trees = [];
  try { trees = readdirSync(path.join(commonDir, 'worktrees')); } catch { return; }
  for (const w of trees) {
    const gitDir = path.join(commonDir, 'worktrees', w);
    if (!existsSync(path.join(gitDir, SPOOL)) && !existsSync(path.join(gitDir, `${SPOOL}.flushing`))) continue;
    try { if (Date.now() - statSync(path.join(gitDir, `${SPOOL}.flushing`)).mtimeMs < 60_000) continue; } catch { /* none */ }
    try { spoolPath({ gitDir, commonDir }); } catch { /* tried again on the next call */ }
  }
}

/**
 * The spool files of a checkout that exist, for reading: never moves or creates anything, so a look at a branch leaves
 * the git dir as it was. A worktree's spool from before the move still lies in its own git dir until the next write.
 */
export function spoolFiles(repo) {
  const own = [path.join(repo.gitDir, SPOOL), path.join(repo.gitDir, `${SPOOL}.flushing`)];
  if (path.resolve(repo.gitDir) === path.resolve(repo.commonDir ?? repo.gitDir)) return own.filter((f) => existsSync(f));
  let id = '';
  try { id = readFileSync(path.join(repo.gitDir, ID), 'utf8').trim(); } catch { /* nothing written here since the move */ }
  const shared = id ? [path.join(repo.commonDir, SPOOLS, `${id}.jsonl`), path.join(repo.commonDir, SPOOLS, `${id}.jsonl.flushing`)] : [];
  return [...shared, ...own].filter((f) => existsSync(f));
}

/** Spools whose worktree was removed before their entries were committed. */
export function orphanSpools(commonDir) {
  let names = [];
  try { names = readdirSync(path.join(commonDir, SPOOLS)); } catch { return []; }
  const live = new Set();
  let trees = [];
  try { trees = readdirSync(path.join(commonDir, 'worktrees')); } catch { /* no linked worktree left */ }
  for (const w of trees) { try { live.add(readFileSync(path.join(commonDir, 'worktrees', w, ID), 'utf8').trim()); } catch { /* none written yet */ } }
  return names.filter((n) => /\.jsonl(\.flushing)?$/.test(n) && !live.has(n.replace(/\.jsonl(\.flushing)?$/, ''))).map((n) => path.join(commonDir, SPOOLS, n));
}

/**
 * Which branch a checkout had at a time, from its HEAD reflog ("checkout: moving from A to B"), read as a file. A time
 * the reflog does not reach (none, or expired) gets the branch checked out now, with branchAssumed.
 */
export function branchesOf(gitDir) {
  const now = branchOf(gitDir);
  let text = '';
  try { text = readFileSync(path.join(gitDir, 'logs', 'HEAD'), 'utf8'); } catch { /* no reflog */ }
  const entries = [];
  for (const l of text.split('\n')) {
    const m = /^\S+ \S+ .*?> (\d+) [+-]\d{4}\t(.*)$/.exec(l);
    if (m) entries.push({ at: Number(m[1]) * 1000, moved: /^checkout: moving from (\S+) to (\S+)$/.exec(m[2]) });
  }
  const sha = (x) => /^[0-9a-f]{7,64}$/.test(x);
  const switches = entries.filter((e) => e.moved);
  return (t) => {
    // reflog times have whole seconds
    if (!entries.length || t < Math.floor(entries[0].at / 1000) * 1000) return { branch: now, branchAssumed: true };
    let branch = now;
    const later = switches.find((e) => e.at > t);
    if (later && !sha(later.moved[1])) branch = later.moved[1];
    // the last switch at or before t. A detached HEAD (a rebase, checkout --detach) keeps the branch it came from; its
    // line may name a branch, but the next switch then leaves from a commit
    switches.forEach((e, i) => {
      if (e.at > t) return;
      const detached = sha(e.moved[2]) || (switches[i + 1] && sha(switches[i + 1].moved[1]));
      branch = detached ? (sha(e.moved[1]) ? branch : e.moved[1]) : e.moved[2];
    });
    return { branch };
  };
}

/**
 * The branches checked out in a git dir while it made one of these commits (a commit, a rebase, a cherry-pick there),
 * from its HEAD reflog: their work went into those commits, under whatever branch carries them now.
 */
export function branchesMaking(gitDir, shas) {
  const at = branchesOf(gitDir);
  const out = new Set();
  let text = '';
  try { text = readFileSync(path.join(gitDir, 'logs', 'HEAD'), 'utf8'); } catch { /* no reflog */ }
  for (const l of text.split('\n')) {
    const m = /^\S+ (\S+) .*?> (\d+) [+-]\d{4}\t(commit|rebase|cherry-pick)/.exec(l);
    if (m && shas.has(m[1])) { const b = at(Number(m[2]) * 1000).branch; if (b) out.add(b); }
  }
  return out;
}

/** The branch of an entry: the one it names, else the one checked out in this git dir when it was recorded. */
export function entryBranch(gitDir) {
  const at = branchesOf(gitDir);
  return (e) => e.branch ?? at(Date.parse(e.at)).branch;
}

/** The branch checked out in a git dir, from its HEAD file; null when detached. */
export function branchOf(gitDir) {
  try { return /^ref: refs\/heads\/(.+)$/m.exec(readFileSync(path.join(gitDir, 'HEAD'), 'utf8'))?.[1] ?? null; } catch { return null; }
}

// every git call of the hook: 3 s at most (the snapshot's limit can be lowered for tests); GIT_OPTIONAL_LOCKS=0 keeps
// git status from taking the index lock, so the hook never collides with the developer's or the agent's own git commands
const SNAPSHOT_TIMEOUT = () => Number(process.env.DEVRECEIPT_HOOK_GIT_TIMEOUT_MS) || 3000;
function gitRead(dir, args, input, timeout = SNAPSHOT_TIMEOUT()) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'ignore'], timeout,
    maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

/**
 * The files git lists as changed or new (also in new folders), with the hash of their content (null: deleted).
 * Hashes only, no content; ignored files are not seen. 'timeout' when git takes longer than the limit.
 */
export const MAX_LISTED = 2000;
export function snapshot(root, mode) {
  try {
    let raw = gitRead(root, ['status', '--porcelain=v1', '-z', `--untracked-files=${mode ?? 'all'}`]).split('\0');
    // many new files not in .gitignore (a build folder): hashing them all costs seconds, so a new folder counts as one
    if (!mode && raw.length > MAX_LISTED) return snapshot(root, 'normal');
    const files = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i].length < 4) continue;
      files.push(raw[i].slice(3));
      if (/^[RC]/.test(raw[i])) i++; // a rename names its old path next
    }
    const present = files.filter((f) => !f.includes('\n') && existsSync(path.join(root, f)) && statSync(path.join(root, f)).isFile());
    const hashes = present.length ? gitRead(root, ['hash-object', '--stdin-paths'], `${present.join('\n')}\n`).trim().split('\n') : [];
    const hash = new Map(present.map((f, i) => [f, hashes[i]]));
    return { mode: mode ?? 'all', files: Object.fromEntries(files.map((f) => [f, hash.get(f) ?? null])) };
  } catch (e) {
    if (e?.code === 'ETIMEDOUT' || e?.signal === 'SIGTERM') return 'timeout';
    throw e;
  }
}

/** Files listed after a command whose content is new or other than before it: what the command changed. */
export function changedBy(before, after) {
  return Object.keys(after.files).filter((f) => !(f in before.files) || before.files[f] !== after.files[f]).sort();
}

const PRE = 'devreceipt-pre';
const preFile = (gitDir, input) => path.join(gitDir, PRE, `${String(input.tool_use_id ?? input.session_id ?? 'x').replace(/[^\w-]/g, '')}.json`);

const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };

/**
 * Passed, failed and skipped from the summary a test runner prints (node --test, jest, vitest, mocha, pytest), or null
 * when there is none (output cut by tail or grep, another runner). Only the counts are kept, and the names of skipped
 * tests (skippedTests); never the rest of the output.
 */
export function testResults(text) {
  const t = String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '');
  const last = (re) => { let m = null; for (const x of t.matchAll(re)) m = x; return m; };
  const count = (line, word) => Number(new RegExp(`(\\d+) ${word}`).exec(line)?.[1] ?? 0);
  const node = { pass: last(/^# pass (\d+)$/gm), fail: last(/^# fail (\d+)$/gm) };
  if (node.pass && node.fail) return { passed: Number(node.pass[1]), failed: Number(node.fail[1]), skipped: Number(last(/^# skipped (\d+)$/gm)?.[1] ?? 0) };
  const jest = last(/^Tests:\s+(.*\d+ total)\s*$/gm);
  if (jest) return { passed: count(jest[1], 'passed'), failed: count(jest[1], 'failed'), skipped: count(jest[1], 'skipped') + count(jest[1], 'todo') };
  const vitest = last(/^\s*Tests\s+(.*\d+ (?:passed|failed|skipped).*)\(\d+\)\s*$/gm);
  if (vitest) return { passed: count(vitest[1], 'passed'), failed: count(vitest[1], 'failed'), skipped: count(vitest[1], 'skipped') + count(vitest[1], 'todo') };
  const mocha = last(/^\s*(\d+) passing/gm);
  if (mocha) return { passed: Number(mocha[1]), failed: Number(last(/^\s*(\d+) failing/gm)?.[1] ?? 0), skipped: Number(last(/^\s*(\d+) pending/gm)?.[1] ?? 0) };
  const pytest = last(/^=+ (.*\d+ (?:passed|failed).*) in [\d.]+s/gm);
  if (pytest) return { passed: count(pytest[1], 'passed'), failed: count(pytest[1], 'failed') + count(pytest[1], 'errors?'), skipped: count(pytest[1], 'skipped') };
  return null;
}

/**
 * Where skipped tests are, never their names (a name is free text): the test file jest printed them under (--verbose),
 * or pytest's file:line (-rs). At most 20, only what passes as a path.
 */
export function skippedTests(text) {
  const t = String(text ?? '').replace(/\u001b\[[0-9;]*m/g, '');
  const found = [];
  let file = null;
  for (const l of t.split('\n')) {
    const head = /^(?:PASS|FAIL)\s+(\S+)/.exec(l);
    if (head) { file = head[1]; continue; }
    if (file && /^\s*○ (?:skipped|todo) /.test(l)) found.push(file);
    const py = /^SKIPPED \[\d+\] ([^\s:]+):(\d+)/.exec(l);
    if (py) found.push(`${py[1]}:${py[2]}`);
  }
  return [...new Set(found)].filter((f) => harmless(f.replace(/:\d+$/, ''))).slice(0, 20);
}

/** Test patterns (a list, as before) or { test, coverage, typecheck, lint, build } lists, with the defaults filled in. */
function checkPatterns(patterns) {
  const p = Array.isArray(patterns) ? { test: patterns } : patterns ?? {};
  return { ...DEFAULT_CHECK_PATTERNS, test: DEFAULT_TEST_PATTERNS, ...p };
}

/** One log entry for a hook payload, or null for calls that are not logged. root: the repository the call belongs to. */
export function entryFor(input, root, patterns = DEFAULT_TEST_PATTERNS, at = new Date().toISOString()) {
  const base = { v: 1, source: 'claude-code', session: String(input.session_id ?? ''), at, tool: input.tool_name };
  const failed = input.hook_event_name === 'PostToolUseFailure';
  if (input.tool_name === 'Bash') {
    const cmd = String(input.tool_input?.command ?? '');
    const code = failed ? String(input.error ?? '').match(/^Exit code (\d+)/)?.[1] : '0';
    const exit = code == null ? null : Number(code); // null: interrupted or failed without an exit code
    const k = checkPatterns(patterns);
    // a coverage run is a test run that also writes a coverage report: a coverage runner, or a test command with --coverage/--cov
    let kind = testCommand(cmd, k.coverage) ? 'coverage' : testCommand(cmd, k.test) ? (/(^|\s)--(experimental-test-)?cov(erage)?(\s|=|$)/.test(cmd) ? 'coverage' : 'test') : null;
    const pats = kind === 'coverage' && testCommand(cmd, k.coverage) ? k.coverage : kind ? k.test : null;
    let checkPats = pats;
    if (!kind) for (const x of ['typecheck', 'lint', 'build']) if (testCommand(cmd, k[x])) { kind = x; checkPats = k[x]; break; }
    if (!kind) return { ...base, test: false, program: program(cmd), exit };
    const command = testCommand(cmd, checkPats);
    const own = testExit(cmd, checkPats, exit);
    const tests = kind === 'test' || kind === 'coverage';
    // the output: in tool_response for a call that succeeded, after "Exit code N" in error for one that failed
    const output = failed ? String(input.error ?? '').replace(/^Exit code \d+\n?/, '') : `${input.tool_response?.stdout ?? ''}\n${input.tool_response?.stderr ?? ''}`;
    const results = tests ? testResults(output) : null;
    // the line's exit code is kept apart when it is not the check's, so nobody reads it as its result
    const ran = own === null && exit !== null ? { exit: null, lineExit: exit } : { exit: own };
    const skipped = results?.skipped ? skippedTests(output) : [];
    return { ...base, test: tests, kind, command, ...ran, ...(results ? { results } : {}), ...(skipped.length ? { skippedNames: skipped } : {}) };
  }
  const key = FILE_TOOLS[input.tool_name];
  if (!key || failed) return null; // a failed edit changed nothing
  const file = real(String(input.tool_input?.[key] ?? ''));
  const rel = path.relative(root, file);
  return { ...base, path: !rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? 'outside' : rel.split(path.sep).join('/') };
}

/** .devreceipt/config.json of the repository: testPatterns, checkPatterns ({ coverage, typecheck, lint, build }), readOnlyCommands (lists of commands), shellEdits ("on" | "off"). */
// files without code a test runs: translations, data, docs, styles, lockfiles. Neither counted for coverage nor named
// as missing from the report
export const DEFAULT_COVERAGE_IGNORE = ['**/i18n/**', '**/locales/**', '**/*.json', '**/*.md', '**/*.css', '**/*.scss', '**/*.yaml', '**/*.yml', '**/*.lock', '**/package-lock.json', '**/pnpm-lock.yaml'];

export function config(root) {
  let c = {};
  try { c = JSON.parse(readFileSync(path.join(root, '.devreceipt', 'config.json'), 'utf8')) ?? {}; } catch { /* none or broken: defaults */ }
  const list = (v, fallback) => (Array.isArray(v) && v.every((x) => typeof x === 'string') && usable(v).length ? v : fallback);
  const checks = Object.fromEntries(Object.entries(DEFAULT_CHECK_PATTERNS).map(([k, d]) => [k, list(c.checkPatterns?.[k], d)]));
  return { testPatterns: list(c.testPatterns, DEFAULT_TEST_PATTERNS), checkPatterns: checks, readOnly: list(c.readOnlyCommands, DEFAULT_READ_ONLY), coverageReports: list(c.coverageReports, ['coverage/lcov.info', 'coverage/coverage-final.json', 'coverage.xml']), coverageIgnore: list(c.coverageIgnore, DEFAULT_COVERAGE_IGNORE), shellEdits: c.shellEdits === 'off' ? 'off' : 'on' };
}

export function handle(raw) {
  const input = JSON.parse(raw);
  const key = FILE_TOOLS[input.tool_name];
  // a file belongs to the repository it lies in, a command to the one it ran in
  const target = key && input.tool_input?.[key] ? path.dirname(real(String(input.tool_input[key]))) : String(input.cwd ?? process.cwd());
  let repo;
  try { repo = repoOf(existsSync(target) ? target : String(input.cwd ?? process.cwd())); } catch { return; } // not in a repository: nothing to record
  adoptWorktreeSpools(repo.commonDir);
  const cfg = config(repo.root);
  // which shell commands get the before/after check; PreToolUse and PostToolUse decide alike from the same command
  const skip = input.tool_name === 'Bash' ? (cfg.shellEdits === 'off' ? 'off' : readOnly(String(input.tool_input?.command ?? ''), cfg.readOnly) ? 'read-only' : null) : null;
  // read-only leaves a marker: another hook (rtk) may rewrite the command before it runs, so PostToolUse sees a different one
  if (input.tool_name === 'Bash' && input.hook_event_name === 'PreToolUse') return skip === 'off' ? undefined : skip ? mark(repo, input) : remember(repo, input);
  const entry = entryFor(input, repo.root, { ...cfg.checkPatterns, test: cfg.testPatterns });
  if (entry && input.tool_name === 'Bash') {
    // the command itself is logged even when finding its files fails
    if (skip) { entry.status = skip; rmSync(preFile(repo.gitDir, input), { force: true }); }
    else try { Object.assign(entry, shellEdits(repo, input, !!entry.kind)); } catch { entry.status = 'error'; }
  }
  // the content an edit left, as git's hash of it: a later change nobody recorded (by hand, a commit hook) shows as a
  // different blob in the commit. Only the hash, never the content.
  if (entry && key && input.tool_name !== 'Read' && entry.path !== 'outside') {
    const file = path.join(repo.root, entry.path);
    try { if (existsSync(file)) entry.hash = gitRead(repo.root, ['hash-object', '--', file]).trim(); } catch { /* the edit is logged without it */ }
  }
  // one complete line per write, so a merge or a parallel session never leaves half a line
  // the branch, so a spool left over from a removed worktree still finds its branch
  if (entry) appendFileSync(spoolPath(repo), `${JSON.stringify({ ...entry, ...(branchOf(repo.gitDir) ? { branch: branchOf(repo.gitDir) } : {}) })}\n`);
}

/** Before a shell command: what git lists as changed, kept until the command is done. */
function remember(repo, input) {
  const dir = path.join(repo.gitDir, PRE);
  mkdirSync(dir, { recursive: true });
  // a command that never finished (denied, interrupted) leaves its snapshot; an hour later it goes
  for (const f of readdirSync(dir)) if (Date.now() - statSync(path.join(dir, f)).mtimeMs > 3600_000) rmSync(path.join(dir, f), { force: true });
  const snap = snapshot(repo.root);
  writeFileSync(preFile(repo.gitDir, input), JSON.stringify(snap === 'timeout' ? snap : { ...snap, head: headOid(repo) }));
}

/** The commit HEAD points at, read from the ref files: no git process for it. */
export function headOid(repo) {
  try {
    const head = readFileSync(path.join(repo.gitDir, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5);
    for (const dir of [repo.gitDir, repo.commonDir ?? repo.gitDir]) { try { return readFileSync(path.join(dir, ref), 'utf8').trim(); } catch { /* packed */ } }
    return new RegExp(`^([0-9a-f]{40,64}) ${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').exec(readFileSync(path.join(repo.commonDir ?? repo.gitDir, 'packed-refs'), 'utf8'))?.[1] ?? null;
  } catch { return null; }
}

/** Before a read-only shell command: no snapshot, only that it was read-only. */
function mark(repo, input) {
  mkdirSync(path.join(repo.gitDir, PRE), { recursive: true });
  writeFileSync(preFile(repo.gitDir, input), '"read-only"');
}

/** After a shell command: the files it changed or created, or why that is unknown. */
function shellEdits(repo, input, check = false) {
  const f = preFile(repo.gitDir, input);
  if (!existsSync(f)) return { status: 'no-snapshot' }; // e.g. the hook was installed while the command ran
  const before = JSON.parse(readFileSync(f, 'utf8'));
  rmSync(f, { force: true });
  if (before === 'read-only') return { status: 'read-only' };
  const after = before === 'timeout' ? 'timeout' : snapshot(repo.root, before.mode);
  if (after === 'timeout') return { status: 'timeout' };
  const files = changedBy(before, after);
  // a check run: what it ran on, the changed files' hashes from the snapshot taken before it and the commit they were
  // changed against (every other file was as committed there). Nothing new is read for it
  const inputs = check ? { inputs: before.files, ...(before.head ? { inputsHead: before.head } : {}) } : {};
  if (!files.length) return inputs;
  // null: deleted; a folder that stands for its new files has none
  const hashes = Object.fromEntries(files.filter((x) => !x.endsWith('/')).map((x) => [x, after.files[x] ?? null]));
  return { files, hashes, git: gitOnly(String(input.tool_input?.command ?? '')), ...inputs };
}

/** Errors of the hook, in the user's own folder (not a shared temp folder another user could plant a link in). */
const ERRORS = () => path.join(process.env.DEVRECEIPT_HOOK_ERRORS_DIR ?? path.join(os.homedir(), '.cache', 'devreceipt'), 'hook-errors.log');

/**
 * The branch of the DevReceipt checkout this hook file lies in (<checkout>/plugin/hooks/), when that is not main: work in
 * progress. A session started while the plugin was read from a working folder keeps running that folder's hook until it
 * reloads its plugins (docs/DOGFOOD-SETUP.md); such a hook records nothing, the session then reads "working without the
 * plugin", and its calls come back through the transcript import. null for main and for an installed copy.
 */
export function unreleased(hookFile) {
  const checkout = path.resolve(path.dirname(hookFile), '..', '..');
  try {
    const dotGit = path.join(checkout, '.git');
    const gitDir = statSync(dotGit).isFile() ? path.resolve(checkout, readFileSync(dotGit, 'utf8').replace(/^gitdir:\s*/, '').trim()) : dotGit;
    const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    return head === 'ref: refs/heads/main' ? null : head.replace(/^ref: refs\/heads\//, '');
  } catch { return null; } // not a checkout: an installed copy
}

// ---------- the merge gate (off unless the developer turned it on: devreceipt setup merge-gate on) ----------

/** The developer's own settings, for every repository: ~/.config/devreceipt/config.json. */
export const USER_CONFIG = () => path.join(process.env.DEVRECEIPT_CONFIG_HOME ?? path.join(os.homedir(), '.config', 'devreceipt'), 'config.json');
export function userConfig() {
  try { return JSON.parse(readFileSync(USER_CONFIG(), 'utf8')) ?? {}; } catch { return {}; }
}

/** The branch a command merges in: `git [-C dir] merge [options] <branch>`; null for anything else (--abort too). */
export function mergeOf(cmd) {
  for (const words of commands(cmd)) {
    const { rest } = stripLead(words);
    if (path.basename(rest[0] ?? '') !== 'git') continue;
    let i = 1;
    let dir = null;
    while (i < rest.length && rest[i].startsWith('-')) { if (rest[i] === '-C') { dir = rest[i + 1]; i += 2; } else if (rest[i] === '-c') i += 2; else i++; }
    if (rest[i] !== 'merge') continue;
    const args = rest.slice(i + 1);
    if (args.some((a) => ['--abort', '--continue', '--quit', '--skip'].includes(a))) return null;
    const branch = args.find((a, k) => !a.startsWith('-') && !['-m', '-F', '--message', '--file', '-s', '--strategy', '-X', '--strategy-option'].includes(args[k - 1]));
    return branch ? { branch, dir } : null;
  }
  return null;
}

/**
 * Before the agent merges a branch into the checked-out base: its open points, from the plugin's own command (it only
 * reads). The question to put to the developer, or null: gate off, no merge, nothing open, or no answer in time.
 */
export function gate(input) {
  if (input.tool_name !== 'Bash' || input.hook_event_name !== 'PreToolUse' || userConfig().mergeGate !== true) return null;
  const m = mergeOf(String(input.tool_input?.command ?? ''));
  if (!m) return null;
  const cwd = path.resolve(String(input.cwd ?? process.cwd()), m.dir ?? '.');
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'devreceipt');
  let r;
  try { r = JSON.parse(execFileSync(process.execPath, [bin, 'gate', m.branch, '--cwd', cwd], { encoding: 'utf8', timeout: 9000, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return null; }
  if (!r.points?.length) return null;
  // the question, for the release report: which branch went into the base with which open points
  try {
    const repo = repoOf(cwd);
    appendFileSync(spoolPath(repo), `${JSON.stringify({ v: 1, source: 'claude-code', session: String(input.session_id ?? ''), at: new Date().toISOString(), tool: 'merge-gate', merging: r.branch, points: r.points, ...(branchOf(repo.gitDir) ? { branch: branchOf(repo.gitDir) } : {}) })}\n`);
  } catch { /* the question is asked all the same */ }
  const n = r.points.length;
  return `DevReceipt: ${r.branch} into ${r.base}, ${n} open point${n === 1 ? '' : 's'}:\n${r.points.map((x) => `- ${x}`).join('\n')}\nMerge anyway?`;
}

function main() {
  const done = () => process.exit(0);
  if (process.env.DEVRECEIPT_DEV_HOOK !== '1' && unreleased(fileURLToPath(import.meta.url))) done();
  const fail = (e) => {
    // never the tool input: a JSON parse error quotes it, so it gets a fixed message
    const msg = e instanceof SyntaxError ? 'hook input is not JSON' : e instanceof Error ? e.message.split('\n')[0] : 'error';
    try {
      mkdirSync(path.dirname(ERRORS()), { recursive: true });
      appendFileSync(ERRORS(), `${new Date().toISOString()} ${msg}\n`);
    } catch { /* nothing left to do */ }
    done();
  };
  process.on('uncaughtException', fail);
  setTimeout(done, 5000); // a stdin that never ends; the gate after it may take 9 s more, Claude Code stops at 15 s
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('error', done);
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let ask = null;
    try { ask = gate(JSON.parse(raw)); } catch { /* the gate never stops the agent */ }
    try { handle(raw); } catch (e) { fail(e); }
    // written at once: process.exit right after does not wait for a pipe
    if (ask) writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: ask } }));
    done();
  });
}

// bundled into DevReceipt's server and CLI (src/ack.ts imports repoOf), import.meta.url is the bundle, which is argv[1]
// too: only this file by its own name is the hook, or main() would read stdin and exit the server
try {
  if (process.argv[1] && import.meta.url.endsWith('/agent-log.mjs') && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
} catch { process.exit(0); }

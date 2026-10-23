# DevReceipt

DevReceipt shows what was demonstrably checked in your work with Claude Code, and what was not. A plugin for Claude
Code. It does not review your code and does not say the code is correct: it names what ran, with which result, and
whether it ran after the last change. Where nothing was recorded it says "not observed" instead of guessing.

## Install

```bash
claude plugin marketplace add josefheld/devreceipt
claude plugin install devreceipt@devreceipt
```

Sessions that are already running pick it up with `/reload-plugins`. Updates: turn on auto-update for the marketplace
(`/plugin` > Marketplaces > devreceipt > Enable auto-update).

From then on a hook records what the agent does in each repository: edits, test runs, typecheck, lint and build runs
and their results. Work from before the install comes from Claude Code's own session transcripts.

## Use

- `/devreceipt` shows what was checked in the current branch, and what was not. On `develop` itself it checks what goes
  out with the next push, against `origin/develop`. In a terminal: `devreceipt`.
- `/devreceipt:release`, on `develop`, shows what goes out with the next release: whether `develop` as a whole passed
  its checks after its last change, each merged branch as it was merged, and at the end `NEXT:`, `RISK:` and `OPEN:`
  lines with what to do before the release.
- `/devreceipt:setup` turns on the merge gate (off by default): before the agent runs `git merge <branch>` on
  `develop`, `main` or `master`, Claude Code asks you if the branch has open points.
- `devreceipt pr`, in a branch's checkout, prints a block for a pull request description and commits the agent log
  (`.devreceipt/agent-log/`); `--no-commit` only reads.

## What a block says

- Tests, typecheck, lint, build: checked (passed after the last change), stale (passed before a later change), not
  checked, or not observed. A run that names its files covers those files only.
- Coverage: the share of changed lines a coverage run executed after their last change, from an lcov, istanbul JSON or
  coverage.py XML report your own run wrote (for example `npx jest <files> --coverage`). Translations, data, docs,
  styles and lockfiles are left out.
- The plan or ticket a branch belongs to; warning signs (a test changed after failing, skipped tests, a failed run
  not run again); changes not committed.

## Settings

Optional, in `.devreceipt/config.json` of a repository: `base`, `testPatterns`, `checkPatterns`, `coverageReports`,
`coverageIgnore`, `readOnlyCommands`, `shellEdits`.

## Privacy

DevReceipt sends nothing anywhere. Its log is a file in your repository's git directory, and with `devreceipt pr` a
file in the repository itself. It keeps paths, commands, exit codes and counts, never file contents; values that may
hold a secret are stored as `[REDACTED]`.

## License

DevReceipt costs 49 EUR once, per developer, with 12 months of updates; compatibility fixes keep coming after that.
https://kigazon.com/devreceipt.html

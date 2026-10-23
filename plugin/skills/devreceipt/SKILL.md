---
description: Shows what was checked in the current branch and what was not, as the block for its pull request - tests, typecheck, lint and build after the last change, fresh diff coverage, the linked plan or ticket. Use when the developer runs /devreceipt or asks, before a pull request, whether the change was checked.
argument-hint: "[base branch]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/devreceipt pr *)
---

Run `${CLAUDE_PLUGIN_ROOT}/bin/devreceipt pr --no-commit --session` in the repository you are working in. If the developer named a
base branch ($ARGUMENTS), add `--base <that branch>`.

Your reply starts with its output, copied as it is (plain text: no code block, no quote, nothing before it), so the
developer reads it without opening the tool result. After it, one sentence of your own in the developer's language
that says the first point of the list. Add nothing the output does not say: no findings of your own from the session,
no judgement of the code, no checks run on your own. The list says what was observed, and the developer decides what
to do about it.

On the base branch itself (develop, main), the command checks what goes out with the next push: the commits the branch
has and its upstream (origin/develop) does not.

`--no-commit` writes nothing; `--session` keeps the details readable in the session. To put the block into the pull request description, the developer runs
`devreceipt pr` without it in a terminal: that first commits the agent log, so the reviewer's checkout holds what the
block says.

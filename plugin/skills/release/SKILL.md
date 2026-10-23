---
description: Shows what goes out with the next release - every branch merged into develop since main or master, with its checks as they were at the merge, the open ones first. Use when the developer runs /devreceipt:release or asks, before a release or deploy, what goes out unchecked.
argument-hint: "[release branch]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/devreceipt release *)
---

Run `${CLAUDE_PLUGIN_ROOT}/bin/devreceipt release --cwd <the repository you are working in>`. If the developer named the
release branch ($ARGUMENTS), add `--to <that branch>`.

Show its output unchanged, first and word for word. Then name the first branch with open points in one sentence, if
there is one. Add nothing the output does not say: do not judge the code and do not run checks on your own. The
developer decides what to do about it.

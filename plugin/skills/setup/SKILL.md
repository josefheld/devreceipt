---
description: Sets up DevReceipt for the developer - the merge gate, off by default. Use when the developer runs /devreceipt:setup or asks to turn the merge gate on or off.
argument-hint: "[on|off]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/devreceipt setup *)
---

The merge gate: when it is on, and you (the agent) run `git merge <branch>` while develop, main or master is checked
out, DevReceipt checks the branch first. If tests, typecheck, lint or build did not pass after its last change, or a
warning sign or open point remains, Claude Code asks the developer before the merge and names those points. The
developer decides; the gate never blocks and commits nothing. It notes each question in the agent log, so
`devreceipt release` can say later that a branch was merged despite open points. It holds for every repository on this machine and
only for merges the agent runs, not for merges in a terminal.

If the developer said on or off ($ARGUMENTS), use that. Otherwise explain the gate in two sentences and ask them with
AskUserQuestion: "Turn the merge gate on?" with the options "On" and "Off".

Then run `${CLAUDE_PLUGIN_ROOT}/bin/devreceipt setup merge-gate on` (or `off`) and show its one line of output.

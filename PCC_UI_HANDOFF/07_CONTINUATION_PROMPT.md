# PCC UI SESSION CONTINUATION TEMPLATE

Use this file when Claude Code hits a usage/session limit.

Read `PCC_UI_PROGRESS.md` first, then this handoff folder.

Do NOT redo repository discovery unless the progress file explicitly says the repository materially changed.

Resume from the exact next checkpoint documented in `PCC_UI_PROGRESS.md`.

Preserve all completed UI work and passing tests.

Before making edits:
1. inspect git status
2. inspect the last relevant changed files
3. run the smallest verification needed to establish the current state
4. continue implementation

At the end, update `PCC_UI_PROGRESS.md` with:
- last completed checkpoint
- screens complete
- components complete
- tests last run
- known failures
- exact next action

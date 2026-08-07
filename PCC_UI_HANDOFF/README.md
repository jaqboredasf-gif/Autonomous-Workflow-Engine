# PCC CLAUDE UI HANDOFF v1

This folder is intended to be copied directly into the PCC repository as:

`PCC_UI_HANDOFF/`

Then paste the contents of:

`00_MASTER_CLAUDE_PROMPT.md`

into Claude Code.

## Why this exists
The design/product decisions were moved out of the Claude Code session so Claude can spend more of its usage on:
- reading the current code
- implementing components/screens
- integrating data/auth
- testing
- fixing real code problems

## Files
00_MASTER_CLAUDE_PROMPT.md — paste this into Claude Code.
01_IMPLEMENTATION_CONTRACT.md — product/UI invariants.
02_DESIGN_SYSTEM.md — visual implementation tokens.
03_COMPONENT_LIBRARY.md — reusable UI requirements.
04_SCREEN_BUILD_ORDER.md — dependency-aware implementation order.
05_ACCEPTANCE_CHECKLIST.md — done criteria.
06_BUSINESS_RULES_BR001_BR010.md — already-agreed implementation rules.
07_CONTINUATION_PROMPT.md — resume after a session limit.
PCC_UI_PROGRESS_TEMPLATE.md — progress ledger for Claude to maintain.
screens/ — one focused specification per screen.
00_SOURCE_DESIGN_PACKET/ — prior design packet if available.

## Recommended use
1. Let the current Claude session finish cleanly.
2. Copy this whole folder into the repository root as `PCC_UI_HANDOFF`.
3. Start a fresh Claude Code session from the repo root.
4. Paste `00_MASTER_CLAUDE_PROMPT.md`.
5. Do not paste every file into chat; tell Claude to read the local handoff folder.
6. Let it execute Checkpoint 0, then implementation.

# PCC UI IMPLEMENTATION — MASTER CLAUDE CODE PROMPT

You are continuing development of the Lippolis Purchasing Control Center (PCC).

## YOUR ROLE
You are the implementation engineer. The attached PCC handoff files are the product/design source of truth for this UI build.

Do NOT spend tokens redesigning the product, inventing a new visual language, renaming concepts without necessity, or asking questions already answered by the handoff.

Your highest-value work is:
1. inspect the existing repository,
2. preserve working functionality,
3. identify the minimum gaps between the existing app and this specification,
4. implement the reusable UI foundation,
5. build the product screens,
6. wire them into existing domain/backend behavior where already available,
7. test the result.

## AUTHORITATIVE INPUTS
Read these first, in this order:

1. `PCC_UI_HANDOFF/01_IMPLEMENTATION_CONTRACT.md`
2. `PCC_UI_HANDOFF/02_DESIGN_SYSTEM.md`
3. `PCC_UI_HANDOFF/03_COMPONENT_LIBRARY.md`
4. `PCC_UI_HANDOFF/04_SCREEN_BUILD_ORDER.md`
5. all files under `PCC_UI_HANDOFF/screens/`
6. `PCC_UI_HANDOFF/05_ACCEPTANCE_CHECKLIST.md`
7. `PCC_UI_HANDOFF/06_BUSINESS_RULES_BR001_BR010.md`

If `00_SOURCE_DESIGN_PACKET/` is present, treat it as supporting detail. In a conflict, the numbered UI handoff files above take precedence for this implementation session.

## HARD CONSTRAINTS
- Preserve existing working PCC functionality.
- Do not rewrite the application from scratch.
- Inspect before editing.
- Reuse the existing framework, routing, component patterns, styling conventions, and dependencies where compatible.
- Do not add a major UI framework unless the repository already uses it or there is a concrete implementation need.
- Do not silently alter business rules.
- Do not remove existing tests.
- Do not expose secrets or service-role credentials to the browser.
- Authentication and authorization are distinct.
- Submitted purchasing work must not disappear from the operational queue merely because it is drafted or ordered.
- Partial receiving must remain partial until all required line items are accounted for.
- Vendor email access must be available from the PO workflow.
- Status must be communicated by text, not color alone.
- Mobile receiving must remain touch-friendly.
- Destructive actions require explicit confirmation.

## EXECUTION METHOD

### CHECKPOINT 0 — REPOSITORY INSPECTION
Before writing code:
- identify framework and package manager
- identify current routes/pages
- identify current UI components
- identify current auth implementation
- identify current Supabase/database integration
- identify current PCC domain models/statuses
- identify current tests
- identify existing design/styling system
- identify which required screens/capabilities already exist

Write a compact `PCC_UI_GAP_REPORT.md` containing:
- EXISTING
- PARTIAL
- MISSING
- CONFLICTS
- SAFE REUSE OPPORTUNITIES

Do not over-document. This report is for implementation control, not prose.

### CHECKPOINT 1 — REUSABLE UI FOUNDATION
Implement or reconcile the reusable PCC UI system before screen-specific duplication.

Required minimum families:
- Button
- Input
- Search
- Select
- Textarea
- Badge / StatusBadge
- Card
- KPI Card
- Data Table primitives
- Sidebar
- Topbar
- Breadcrumb
- Tabs
- Filter controls
- Timeline
- Activity item/feed
- Alert
- Toast if app architecture supports it
- Confirmation dialog
- Empty state
- Loading/skeleton
- File/photo upload shell
- Receiving item control

Use existing primitives if the repository already has suitable equivalents. Adapt; do not duplicate.

### CHECKPOINT 2 — PRODUCT SHELL
Build the shared authenticated application shell:
- Sidebar
- Topbar
- responsive content region
- role-aware navigation presentation
- global page heading pattern
- responsive behavior

### CHECKPOINT 3 — SCREENS
Implement in this order unless repository dependencies make a slightly different order objectively safer:

01 Login / Authentication
02 Dashboard
03 New Request
04 Purchasing Queue
05 Purchase Order Detail
06 Receiving
07 Vendors
08 Vendor Profile
09 Material Catalog
10 Administration

Read the corresponding file under `screens/` immediately before implementing each screen.

### CHECKPOINT 4 — RESPONSIVE + STATES
For every completed screen verify:
- desktop
- narrow desktop/tablet where relevant
- mobile where relevant
- loading
- empty
- error
- permission denied / unauthorized where applicable
- disabled action behavior

Receiving is explicitly mobile-first.

### CHECKPOINT 5 — TEST + VERIFY
Run the existing relevant test suite plus new focused tests.

At minimum verify:
- no type errors
- no lint errors introduced
- production build succeeds if repository provides build command
- route smoke tests
- status rendering
- permission-aware action visibility where feasible
- partial receiving UI state
- drafted/ordered entries remain visible in queue
- vendor email action exists in PO workflow
- no hard deletion exposed for submitted purchasing records

## TOKEN / USAGE DISCIPLINE
Do not narrate every small edit.
Do not repeatedly summarize unchanged requirements.
Do not regenerate specifications already supplied.
Prefer reading targeted files over recursively dumping the entire repo.
Prefer small, safe implementation batches with tests.
Reuse existing components and utilities.
If a decision is reversible and conventional, make the smallest compatible decision and continue.
Only stop for clarification when a missing fact materially changes business behavior, authority, security, or data integrity.

## VISUAL DIRECTION
The PCC should feel:
- professional
- operational
- trustworthy
- high information density on desktop
- minimal decoration
- modern but not flashy
- optimized for purchasing staff and electricians
- field-friendly on mobile

Font: Inter where compatible with the existing app.

Primary action blue: #2563EB
Primary hover: #1D4ED8
Background: #F8FAFC
Surface: #FFFFFF
Primary text: #0F172A
Secondary text: #64748B
Default border: #E2E8F0

Semantic:
Success: #16A34A / #F0FDF4
Warning: #D97706 / #FFFBEB
Danger: #DC2626 / #FEF2F2
Info: #0284C7 / #F0F9FF

## REQUIRED END-OF-SESSION OUTPUT
At the end, report ONLY:
1. checkpoints completed
2. screens completed
3. files materially changed
4. tests/build commands run and results
5. blockers
6. exact next checkpoint

If the full UI cannot be completed in one session, leave the repository in a clean, tested state and write/update `PCC_UI_PROGRESS.md` so the next Claude Code session can resume without rediscovery.

BEGIN WITH CHECKPOINT 0.

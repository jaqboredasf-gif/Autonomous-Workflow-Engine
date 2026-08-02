# Agent Operating Policies

**Binding on every Claude Code / Codex session in this repository.**
Last updated 2026-08-01. These are session rules, not aspirations. A session that breaks one has
failed regardless of what it produced.

---

## P1 — Inspect before editing

Read the file before changing it. Read `context/AWE_CURRENT_STATE.md` before claiming anything about
state. State your branch, HEAD SHA, and dirty status at the start of the session.

## P2 — Repository evidence outranks narrative

Evidence hierarchy, highest first:

1. Repository inspection 2. Test/runner output 3. Migration and database state 4. Runtime output
5. Workflow export and platform configuration 6. Documentation 7. Prior agent handoffs
8. Conversation history

A number in a handoff is rank 7. It becomes rank 2 only when a suite is re-run. **Do not promote a
claim by repeating it.**

## P3 — No fabricated tests or results

Never report a passing suite you did not run. Paste real output. If a suite fails, say so and
include the failure. `mcp-smoke` currently fails on this PC because `jq` is missing — that is
recorded, not hidden.

## P4 — No live side effects

No live Microsoft Graph call. No live Supabase write. No outbound email — real or synthetic
recipient. No n8n workflow activation, publication, or execution. No production or customer system.

## P5 — No remote migration application

Migration files may be read and linted. `supabase db push` and any equivalent against a shared or
remote database is forbidden. Isolated local containers only, and only once Docker works.

## P6 — Destructive Git is forbidden

No `push`, `merge`, `rebase`, `reset --hard`, `checkout` over dirty work, branch deletion, force
push, or history rewrite. Opening a PR requires explicit human instruction — especially the
`feat/kernelized-mcp-context` → `main` base PR, on which 33 commits depend.

## P7 — Never merge to `main`

`main` is 8 commits ahead of the stack and carries the security and handoff work. Integration
happens on a dedicated branch after a written plan, never opportunistically.

## P8 — No secret exposure

Never print, commit, or paste a credential. `.env` and `.env.*` are gitignored — keep them that way.
When documenting configuration, record **key names only**. Do not read `auth.json`,
`.credentials.json`, or any keyring.

## P9 — No claim of integration without tests

"Integrated" means the relevant runner passed after the change and the output is recorded. Code
existing is not integration. A migration file existing is not an applied migration. A branch
existing is not a merged capability.

## P10 — Preserve repository language

The repo says `work_requests`, `email_messages`, `approval_drafts`, `tenant`, `worker`, `capability`.
The handoff says `objective`, `work_package`, `responsibility`, `replan`. **Map, do not rename.**
Renaming breaks migrations and APIs. See `context/AWE_UBIQUITOUS_LANGUAGE.md`.

## P11 — Do not invent architecture

Do not create a plane, layer, or abstraction because a handoff mentioned it. If it has no package,
no table, and no test, it does not exist — record it as missing.

## P12 — Inspect scripts before running them

Read a script's header and grep it for network, credential, and database access before execution.
`scripts/regression.sh --dry-run` and `--kinds=unit,offline,static` exist precisely for this.

## P13 — Bounded scope per session

One capability at a time. When blocked on one item, continue with other safe repository-grounded
work rather than stopping — but do not widen scope into a new capability.

## P14 — Every material claim carries evidence

File path, symbol or table, branch or commit, and the runner that proves it. A claim without those
four is a hypothesis and must be labelled as one.

## P15 — Every session ends with a durable handoff

Update `context/LATEST_AGENT_HANDOFF.md` with branch, commit, what was inspected, what was created,
what was verified, what remains unknown, files changed, commands run, Git status, the next safest
bounded task, and an explicit statement of what was intentionally not executed.

## P16 — Leave the tree understandable

No stray artifacts (`artifacts/` is gitignored — keep it so). No half-finished refactors. No
unrelated changes mixed into a commit.

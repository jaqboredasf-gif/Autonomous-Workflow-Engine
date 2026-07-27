# H1 — Harness pure core: implementation brief

One session. **Pure code only: no database, no network, no clock, no randomness,
no migration, no seed, no live change.** If a line of H1 needs any of those, it is
not H1.

Prerequisites: `AGENT_HARNESS_H0_EXIT.md` §2 (entry criteria) — chiefly ADR-0001
`Accepted` and a green regression baseline captured before any edit.

## 1. Goal

Create `packages/harness` containing the harness's pure core — descriptor
validation, token estimation, digests, error taxonomy, refusal vocabulary, and
redaction — plus an offline unit suite and a layering lint, wired into
`regression.sh`. Nothing in H1 can reach a database, a provider, or the network.

Why this shape: every later task imports these modules, and everything here is
evaluable with zero infrastructure — the same discipline that makes
`approval-matrix.mjs` and `approval-diff.mjs` cheap to test.

## 2. Files likely to be created

```
packages/harness/package.json                 name @exattime/harness, type module, no runtime deps
packages/harness/README.md                    what is pure, what is not, import rules
packages/harness/src/index.mjs                the only stable export surface
packages/harness/src/registry/descriptor.mjs  ToolDescriptor validation (contract §1.1 rules 1–7)
packages/harness/src/registry/digest.mjs      canonical JSON + sha256 (node:crypto only)
packages/harness/src/context/tokens.mjs       deterministic token estimator
packages/harness/src/failure/taxonomy.mjs     8 error classes + classify() from a shaped error
packages/harness/src/failure/reasons.mjs      BlockedReason union + exhaustiveness helper
packages/harness/src/telemetry/redact.mjs     secret deny-list + redact()/digestValue()
packages/harness/test/*.test.mjs              node:test suites (see §4)
scripts/eval-harness-unit.sh                  runs node --test + the layering lint
scripts/lib/lint-harness-layering.mjs         static import check (see §5)
```
Modified: `package.json` (workspaces already glob `packages/*` — verify, do not
edit if it matches), `scripts/regression.sh` (one offline step, placed with the
other offline lints), `docs/planning/TASK_BACKLOG.md`, `docs/planning/SESSION_HANDOFF.md`.

**Not** created in H1: any `db/`, `model/adapters/`, `session/`, `dispatch/`,
`verify/` module; any SQL; any fixture that requires a DB.

## 3. Exported interfaces (from `src/index.mjs`)

```
// registry
validateDescriptor(descriptor) -> { ok, errors[] }      // pure, no I/O
descriptorDigest(descriptor)   -> sha256 hex            // canonical key order, excludes code_digest
EFFECT_CLASSES                 -> ['read','write_internal','human_visible','external']
EFFECT_RANK                    -> { read:0, write_internal:1, human_visible:2, external:3 }
compareEffect(a, b)            -> -1|0|1

// context
estimateTokens(text)           -> int                   // deterministic, over-estimating
estimateItems(items)           -> int

// failure
ERROR_CLASSES                  -> the 8 names (contract §6.1)
classifyError(err)             -> { class, retryable, max_attempts }
BLOCKED_REASONS                -> the full union (contract §2.4)
isRetryable(class)             -> bool                  // guard_block/budget/verify always false

// telemetry
redact(value)                  -> value with secrets replaced by 'sha256:<12>'
containsSecret(text)           -> bool
```

Contract notes:
- `validateDescriptor` **rejects** `effect_class:'external'` (D1/G3), `verify.kind:'none'`
  on a non-read tool (D6), `idempotency.kind:'none'` on a non-read tool (D10),
  `tenancy ≠ 'org_required'` (D4), `timeout_ms` outside `(0, 60000]`.
- `descriptorDigest` must be stable across key order and whitespace; it is the
  value H4's parity check compares against `agent_tools.code_digest`.
- `classifyError` never guesses: an unrecognized error is `tool_error_terminal`
  (fail closed, D15), never a retryable class.

## 4. Unit tests (node:test, `node --test`)

| Suite | Must prove |
|---|---|
| descriptor | each of the 7 validation rules rejects; a valid descriptor passes; `external` is rejected with its own reason |
| digest | key-order and whitespace independence; any field change alters the digest |
| tokens | determinism across runs; monotonic in length; over-estimates a known sample rather than under-estimating |
| taxonomy | all 8 classes classify; `guard_block`, `budget_exhausted`, `verify_failed` are non-retryable; unknown error ⇒ `tool_error_terminal` |
| reasons | union is exhaustive and unique; a duplicate or unknown reason fails |
| redact | planted API key / JWT / `sbp_` token / service-role key / `Authorization` header are all replaced; a non-secret string is untouched |
| purity | importing every module leaves `globalThis.fetch` uncalled (spy) and performs no `node:fs` read |

**Non-vacuity (M2):** for at least the descriptor, taxonomy and redact suites, run
a deliberate perturbation, confirm the suite fails, revert, and record it in the
handoff.

## 5. Prohibited dependencies (enforced, not requested)

`scripts/lib/lint-harness-layering.mjs` statically scans `packages/harness/src/**`
and fails on any of:

- runtime `dependencies` in `packages/harness/package.json` (must be empty; dev-only
  is fine),
- import of `@supabase/supabase-js`, `zod`, `pg`, `node-fetch`, or any `scripts/lib/*`,
- use of `fetch`, `XMLHttpRequest`, `node:http(s)`, `node:child_process`, `node:fs`
  (outside `test/`),
- use of `Date.now()`, `new Date()`, `Math.random()` in pure modules,
- `process.env` access anywhere in `src/`.

Node builtins permitted in `src/`: `node:crypto` (digests) and `node:assert`.
Rationale: purity is what makes these modules replayable and cheap to test; the
lint keeps it true after H1 leaves.

## 6. Acceptance criteria

1. `bash scripts/eval-harness-unit.sh` green: all suites pass and the layering lint
   passes.
2. Layering lint proven non-vacuous: adding `import { createClient } from '@supabase/supabase-js'`
   to a pure module fails the lint (then reverted).
3. `bash scripts/regression.sh` ALL GREEN before and after — same slice counts as
   the pre-H1 baseline, plus the new offline step.
4. `packages/harness/package.json` has **zero** runtime dependencies.
5. No file outside `packages/harness/`, `scripts/eval-harness-unit.sh`,
   `scripts/lib/lint-harness-layering.mjs`, `scripts/regression.sh`, and the two
   planning docs is modified.
6. Zero database calls in the session (no `.env.acceptance` needed to run the new
   suite; regression still needs it for the existing slices).
7. `git status` shows no migration file, no `supabase/` change, no S1 artifact touched.

## 7. Stop conditions (stop and report; do not work around)

- Regression is not green **before** starting → stop; that is a pre-existing failure
  and its own task.
- Adding the workspace package changes existing install/build behavior (web build or
  mobile typecheck reacts) → stop and report; H1 must be invisible to both apps.
- Any test needs a database, a key, or a network call → the design is wrong for H1;
  stop and move that piece to its later task.
- ADR-0001 is not yet `Accepted` → do not start.
- Regression time grows by more than ~10s → investigate before proceeding.

## 8. Rollback strategy

Everything H1 adds is new files plus three small edits. Rollback = delete
`packages/harness/`, `scripts/eval-harness-unit.sh`,
`scripts/lib/lint-harness-layering.mjs`, revert the `regression.sh` step and the
two doc edits. No database state, no migration, no live change exists to undo. Work
on branch `feat/h1-harness-core`; do not commit or push without Jack's go-ahead
(standing rule).

## 9. Definition of done

Green unit suite + green layering lint + green full regression + non-vacuity
perturbations recorded + `TASK_BACKLOG.md` H1 entry moved to `done` with the
shipped-file list + `SESSION_HANDOFF.md` updated with the exact next prompt
(H2 or, if AC-1 sequencing is preferred, the S1/0016 apply decision first).

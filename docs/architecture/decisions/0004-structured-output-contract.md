# ADR-0004 — Strict JSON-in-text output; native tool-calling deferred (open question O3)

**Status:** Proposed (2026-07-27) — awaiting Jack's ratification.

## Context

`scripts/lib/classification.mjs` gets structured data out of the model by asking
for a JSON object in the text response, then `parseModelText()` +
`validateModelOutput()` + fail-closed. The Anthropic adapter is a raw `fetch` with
no SDK. Provider-native tool-calling (`tools:` + `tool_use` blocks) is the
alternative, and it changes the adapter interface, the retry semantics, and the
eval fixtures.

## Decision

**Keep the strict JSON-in-text contract for v1.** The `ModelAdapter` interface
carries a `capabilities` field (`{ native_tools: false }`) so a future adapter can
declare otherwise, but no harness code branches on it yet, and one model turn
produces at most one tool intent.

Requirements that stay in force:
- output parsed then schema-validated before anything else happens;
- one repair retry on `invalid_output`, then fail-closed to the human queue (G12);
- recorded outputs (`fixtures/emails/model_recorded.json`) remain replayable —
  the replay adapter must keep working unchanged.

## Alternatives considered

- **Native tool-calling now.** Rejected for v1: it would rewrite the recorded-output
  fixture format and invalidate Runner 2A's replay corpus, which is the parity gate
  the entire harness build is measured against (H12). Do not change the measuring
  instrument in the same change that builds the thing being measured.
- **A schema-constrained decoding / JSON-mode flag.** Rejected as provider-specific:
  it would push a provider capability into the domain contract, against G20
  (portability). Revisit as an adapter-level optimization that must not alter
  observable output.

## Consequences

- Sessions needing several tool calls sequence them across loop iterations, one
  model turn each. Slightly more model calls per session; entirely deterministic
  and fully visible in the step ledger.
- The parse/validate/repair path stays the single failure mode for malformed
  output — one code path, already proven by B2.
- Migration path when a session genuinely needs multi-tool turns: add a
  `native_tools: true` adapter, add a second recorded-output corpus for it, keep the
  JSON path as the replay/regression default. Both then coexist behind the same
  interface.

## Security impact

Positive: text-in/text-out keeps untrusted email content inside a delimited data
block with no provider-side mechanism that could turn model output directly into a
dispatch. Every tool invocation still passes through the dispatcher's guard chain
(G10, G6).

## Operational impact

None new. Same adapter shape, same cost accounting, same fixtures.

## Reversal strategy

Adapter-level flag; no schema, no table, no domain change.

## Related tasks and guardrails

O3 · Tasks H7, H9, H12 · Guardrails G10 (untrusted data), G12 (fail-closed), G20
(provider portability).

# Execution Replay

`service.replay({ run_id, org_id })` verifies:

- every event contract and document digest;
- dense event sequence;
- every `previous_digest`; and
- every event content digest.

It then projects state, lease/retry/recovery/approval/cancellation decisions and
captured effect references. The reference mode is
`control_decision_replay`; captured external effects are simulated and the
report states zero tool/model invocations.

Use:

```js
const replay = service.replay({
  run_id,
  org_id,
  mode: 'control_decision_replay',
  external_effects: 'simulate',
});
```

`divergence` means projected and expected state differ. Replay does not claim to
reproduce uncaptured wall time, model behavior, provider responses or real
external services.

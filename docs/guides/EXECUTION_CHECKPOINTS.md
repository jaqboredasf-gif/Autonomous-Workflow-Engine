# Execution Checkpoints

Checkpoints persist explicit platform state, not arbitrary JavaScript state.

They contain workflow/agent state, completed and pending steps, Context and
Memory snapshot refs, transcript position, tool/effect receipts, policy and
approval evidence, retry state, compensation stack, wake condition, runtime
versions and content digests.

Writes require:

- active lease id;
- worker id;
- current fencing token;
- matching tenant/run/job/attempt;
- expected state version; and
- the next dense checkpoint sequence.

On resume, read `repository.latestCheckpoint({ run_id, org_id })`. Validate the
document and referenced snapshot digests before use. Never persist closures,
promises, sockets, model objects or provider clients.

import {
  assertEvent, canonicalClone, createEvent, deepFreeze, digest, invariant, isPlainObject,
} from '../../awe-kernel/src/index.mjs';

export const AGENT_TRANSCRIPT_SCHEMA = 'awe.agent_transcript/v1';
export const AGENT_TRANSCRIPT_ENTRY_SCHEMA = 'awe.agent_transcript_entry/v1';
export const AGENT_EVENT_TYPES = [
  'agent.run.started',
  'agent.resolution.blocked',
  'agent.context.assembled',
  'agent.model.requested',
  'agent.model.responded',
  'agent.model.failed',
  'agent.tool.requested',
  'agent.tool.completed',
  'agent.tool.blocked',
  'agent.tool.failed',
  'agent.human.requested',
  'agent.budget.exhausted',
  'agent.run.blocked',
  'agent.run.completed',
  'agent.run.failed',
];
export const AGENT_TERMINAL_EVENT_TYPES = [
  'agent.human.requested', 'agent.budget.exhausted', 'agent.run.blocked',
  'agent.run.completed', 'agent.run.failed',
];
export const TRANSCRIPT_KEYS = [
  'schema', 'run_id', 'agent_id', 'agent_version', 'org_id', 'entries',
  'entry_count', 'head_digest', 'transcript_digest',
];
export const ENTRY_KEYS = ['schema', 'seq', 'previous_digest', 'event', 'entry_digest'];

function makeEntry({ seq, previous_digest, event }) {
  const body = {
    schema: AGENT_TRANSCRIPT_ENTRY_SCHEMA,
    seq,
    previous_digest,
    event,
  };
  return deepFreeze({ ...body, entry_digest: digest(body) });
}

function snapshot({ run_id, agent_id, agent_version, org_id, entries }) {
  const head_digest = entries.at(-1)?.entry_digest ?? null;
  const body = {
    schema: AGENT_TRANSCRIPT_SCHEMA,
    run_id,
    agent_id,
    agent_version,
    org_id,
    entries: canonicalClone(entries),
    entry_count: entries.length,
    head_digest,
  };
  return deepFreeze({ ...body, transcript_digest: digest(body) });
}

export function createAgentTranscript({
  run_id, agent_id, agent_version = null, org_id = null, entries = [],
} = {}) {
  invariant(typeof run_id === 'string' && run_id.length > 0, 'invalid_input', 'agent transcript needs run_id', {});
  invariant(typeof agent_id === 'string' && agent_id.length > 0, 'invalid_input', 'agent transcript needs agent_id', {});
  invariant(agent_version === null || typeof agent_version === 'string', 'invalid_input', 'agent_version must be a string or null', {});
  invariant(org_id === null || (typeof org_id === 'string' && org_id.length > 0), 'invalid_input', 'transcript org_id must be a string or null', {});
  const initial = snapshot({ run_id, agent_id, agent_version, org_id, entries });
  verifyAgentTranscript(initial);
  const journal = [...initial.entries];

  return Object.freeze({
    append(event_type, payload = {}, occurred_at = null) {
      invariant(AGENT_EVENT_TYPES.includes(event_type), 'invalid_input', `agent event type '${event_type}' is unknown`, {
        known: AGENT_EVENT_TYPES,
      });
      invariant(isPlainObject(payload), 'invalid_input', 'agent event payload must be a plain object', {});
      invariant(
        !AGENT_TERMINAL_EVENT_TYPES.includes(journal.at(-1)?.event.event_type),
        'contract_violation', 'cannot append after an agent transcript terminal event', {},
      );
      const event = createEvent({
        event_type,
        entity_type: 'agent_run',
        entity_id: run_id,
        org_id,
        payload,
        occurred_at,
      });
      const entry = makeEntry({
        seq: journal.length + 1,
        previous_digest: journal.at(-1)?.entry_digest ?? null,
        event,
      });
      journal.push(entry);
      return entry;
    },
    events: () => journal.map((entry) => entry.event),
    snapshot: () => snapshot({ run_id, agent_id, agent_version, org_id, entries: journal }),
  });
}

export function verifyAgentTranscript(transcript, where = {}) {
  invariant(isPlainObject(transcript), 'contract_violation', 'agent transcript must be a plain object', where);
  for (const key of TRANSCRIPT_KEYS) invariant(Object.prototype.hasOwnProperty.call(transcript, key), 'contract_violation', `agent transcript missing '${key}'`, where);
  const unknown = Object.keys(transcript).filter((key) => !TRANSCRIPT_KEYS.includes(key));
  invariant(unknown.length === 0, 'contract_violation', `agent transcript has unknown key(s) ${JSON.stringify(unknown)}`, where);
  invariant(transcript.schema === AGENT_TRANSCRIPT_SCHEMA, 'contract_violation', 'agent transcript schema is invalid', where);
  invariant(Array.isArray(transcript.entries), 'contract_violation', 'agent transcript entries must be an array', where);
  invariant(transcript.entry_count === transcript.entries.length, 'contract_violation', 'agent transcript entry_count is invalid', where);

  let previous = null;
  transcript.entries.forEach((entry, index) => {
    invariant(isPlainObject(entry), 'contract_violation', `agent transcript entry ${index + 1} must be an object`, where);
    for (const key of ENTRY_KEYS) invariant(Object.prototype.hasOwnProperty.call(entry, key), 'contract_violation', `agent transcript entry missing '${key}'`, where);
    invariant(Object.keys(entry).every((key) => ENTRY_KEYS.includes(key)), 'contract_violation', 'agent transcript entry has unknown keys', where);
    invariant(entry.schema === AGENT_TRANSCRIPT_ENTRY_SCHEMA, 'contract_violation', 'agent transcript entry schema is invalid', where);
    invariant(entry.seq === index + 1, 'contract_violation', `agent transcript sequence breaks at entry ${index + 1}`, where);
    invariant(entry.previous_digest === previous, 'contract_violation', `agent transcript chain breaks at entry ${index + 1}`, where);
    assertEvent(entry.event, { ...where, entry: index + 1 });
    invariant(AGENT_EVENT_TYPES.includes(entry.event.event_type), 'contract_violation', `unknown agent transcript event '${entry.event.event_type}'`, where);
    invariant(entry.event.entity_id === transcript.run_id && entry.event.org_id === transcript.org_id, 'contract_violation', 'agent transcript event identity mismatch', where);
    const { entry_digest, ...body } = entry;
    invariant(digest(body) === entry_digest, 'contract_violation', `agent transcript digest breaks at entry ${index + 1}`, where);
    previous = entry_digest;
  });

  invariant(transcript.head_digest === previous, 'contract_violation', 'agent transcript head_digest is invalid', where);
  const { transcript_digest, ...body } = transcript;
  invariant(digest(body) === transcript_digest, 'contract_violation', 'agent transcript document digest is invalid', where);
  return transcript;
}

export function projectAgentTranscript(transcript) {
  verifyAgentTranscript(transcript, { at: 'projectAgentTranscript' });
  const counts = { turns: 0, model_calls: 0, tool_calls: 0, total_tokens: 0 };
  let state = 'created';
  let reason = null;
  for (const { event } of transcript.entries) {
    if (event.event_type === 'agent.run.started') state = 'running';
    if (event.event_type === 'agent.model.requested') {
      counts.turns += 1;
      counts.model_calls += 1;
    }
    if (event.event_type === 'agent.model.responded') counts.total_tokens += event.payload.usage_units ?? 0;
    if (event.event_type === 'agent.tool.requested') counts.tool_calls += 1;
    if (event.event_type === 'agent.human.requested') {
      state = 'blocked';
      reason = event.payload.reason ?? 'human_input_required';
    }
    if (event.event_type === 'agent.budget.exhausted') {
      state = 'blocked';
      reason = 'agent_budget_exhausted';
    }
    if (event.event_type === 'agent.run.completed') state = 'completed';
    if (event.event_type === 'agent.run.blocked') {
      state = 'blocked';
      reason = event.payload.reason ?? null;
    }
    if (event.event_type === 'agent.run.failed') {
      state = 'failed';
      reason = event.payload.reason ?? 'agent_execution_failed';
    }
    if (event.event_type === 'agent.resolution.blocked' || event.event_type === 'agent.tool.blocked') {
      state = 'blocked';
      reason = event.payload.reason ?? null;
    }
  }
  return deepFreeze({
    schema: 'awe.agent_transcript_projection/v1',
    run_id: transcript.run_id,
    agent_id: transcript.agent_id,
    state,
    reason,
    counts,
    head_digest: transcript.head_digest,
  });
}

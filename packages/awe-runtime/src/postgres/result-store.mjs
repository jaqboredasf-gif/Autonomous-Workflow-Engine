// ---------------------------------------------------------------------------
// postgres/result-store.mjs — the durable step-output store.
//
// The boundary this keeps is the one `result-store.mjs` opens with: the journal
// is a CONTROL record that carries digests and is safe to read while
// investigating an incident, and these are the BODIES — the draft id the fourth
// step produced, without which the consequential step cannot issue a payment
// instruction after a resume. Two stores, two jobs, two tables, and 0017 keeps
// them apart at the schema level so a future writer cannot casually merge them.
//
// A DEFECT THIS ADAPTER SURFACED, and it was in the existing stores.
// `tenantChecked` in the memory and file stores guards the READ only. The write
// was keyed on `run_id` alone, so a second tenant writing the same run id
// silently replaced the first tenant's outputs — the read then correctly refused
// to show them to the wrong tenant, but the right tenant's data was already
// gone. It was invisible because the control-plane service never writes results
// for a run it does not own, so nothing exercised it. The conformance suite
// exercises it against all three stores, and all three now refuse.
// ---------------------------------------------------------------------------

import { KernelError } from '../../../awe-kernel/src/index.mjs';
import { RESULT_DOCUMENT_SCHEMA } from '../result-store.mjs';
import { assertExecutor } from './executor.mjs';

export function createPostgresResultStore({ executor, org_id = null } = {}) {
  assertExecutor(executor, 'createPostgresResultStore');

  return Object.freeze({
    kind: 'result_store',
    name: 'postgres',
    schema: RESULT_DOCUMENT_SCHEMA,
    durable: true,
    cross_process: true,
    org_id,

    async write({ run_id, org_id: tenant = null, results = {} } = {}) {
      const owner = org_id ?? tenant;
      if (org_id !== null && tenant !== null && tenant !== org_id) {
        return Object.freeze({
          ok: false, ref: null, reason: 'result_tenant_mismatch',
          error: `results for run '${run_id}' are not accessible to this tenant`,
        });
      }
      if (typeof run_id !== 'string' || run_id.length === 0 || owner === null) {
        throw new KernelError('invalid_input', 'a result write needs a run_id and a tenant', { run_id });
      }
      const outcome = await executor.call('awe_results_write', { run_id, org_id: owner, results });
      if (outcome === null || typeof outcome !== 'object') {
        throw new KernelError('contract_violation', 'awe_results_write returned no verdict', { run_id });
      }
      return Object.freeze({
        ok: outcome.ok === true,
        ref: outcome.ref ?? null,
        reason: outcome.reason ?? null,
        error: outcome.error ?? null,
      });
    },

    /**
     * read({ run_id, org_id }) -> results object
     *
     * `{}` for absent AND for "not yours", identically — the same rule the whole
     * control plane follows, so a caller that guessed a run id cannot tell which
     * of the two it hit.
     */
    async read({ run_id, org_id: tenant = null } = {}) {
      const owner = org_id ?? tenant;
      if (org_id !== null && tenant !== null && tenant !== org_id) return {};
      if (owner === null) return {};
      const results = await executor.call('awe_results_read', { run_id, org_id: owner });
      if (results === null) return {};
      if (typeof results !== 'object' || Array.isArray(results)) {
        throw new KernelError('contract_violation', `result store returned a non-object for run '${run_id}'`, { run_id });
      }
      return results;
    },

    async list({ org_id: tenant = null } = {}) {
      const scope = org_id ?? tenant;
      const rows = await executor.call('awe_results_list', scope === null ? {} : { org_id: scope });
      if (!Array.isArray(rows)) {
        throw new KernelError('contract_violation', 'awe_results_list returned a non-array', {});
      }
      return rows;
    },
  });
}

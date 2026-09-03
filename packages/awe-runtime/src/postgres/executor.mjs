// ---------------------------------------------------------------------------
// executor.mjs — the one thing the durable stores are allowed to know about a
// database, and the error class that keeps "the network was down" from being
// mistaken for "the tenant may not do that".
//
// THE PORT IS ONE METHOD.
//
//   call(fn, payload) -> Promise<jsonb-as-JS-value | null>
//
// `fn` is one of the eleven functions migration 0017 defines; `payload` is a
// single JSON object. Nothing else crosses this boundary: no SQL, no table
// name, no column, no connection string, no driver type. That is what lets the
// same adapter run over PostgREST in a deployment and over `psql` in a
// container during conformance, and it is why `@exattime/awe-runtime` still
// depends on no database driver — the driver is the CALLER's problem, injected,
// exactly as the artifact sink and the clock already are.
//
// WHY A SINGLE JSONB ARGUMENT rather than typed parameters: PostgREST exposes a
// function's arguments as JSON keys anyway, and a one-argument shape means
// adding a field to a payload does not change eleven signatures, three
// transports and a REST contract at once. The argument is passed as a bound
// parameter by every transport in this repo — no JSON is ever concatenated into
// a SQL string.
//
// THE TWO FAILURE CLASSES, and keeping them apart is the point of this file:
//
//   StoreUnavailableError  the store could not answer. Timeout, dead socket,
//                          permission denied, a container that is gone. The
//                          question was never decided, so a caller may RETRY.
//   KernelError            the store answered and the answer is not a legal
//   ('contract_violation') value for the domain. Retrying will produce the same
//                          bad answer. Fail closed and stop.
//
// A refusal that is a NORMAL OUTCOME — a lost compare-and-set, another tenant's
// run, a lease someone else holds — is neither of these. It is returned as data,
// because a worker pulling from a queue meets those constantly and they are not
// errors at all.
// ---------------------------------------------------------------------------

/**
 * The store could not answer. Deliberately NOT a KernelError: the kernel's
 * taxonomy describes the kernel's own contracts, and a socket timeout is not a
 * contract violation by anybody. Treating it as one would make an outage look
 * like a policy refusal in every log and every report.
 */
export class StoreUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'StoreUnavailableError';
    this.code = 'store_unavailable';
    this.retryable = true;
    this.details = details;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, retryable: true, details: this.details };
  }
}

export function isStoreUnavailable(e) {
  return e instanceof StoreUnavailableError;
}

export const RPC_FUNCTIONS = Object.freeze([
  'awe_journal_write', 'awe_journal_read', 'awe_journal_list',
  'awe_lease_acquire', 'awe_lease_read', 'awe_lease_release',
  'awe_lease_expire', 'awe_lease_list',
  'awe_results_write', 'awe_results_read', 'awe_results_list',
]);

/**
 * assertExecutor(executor) — a store refuses to be built on something that is
 * not a transport, rather than failing on the first write of a real run.
 */
export function assertExecutor(executor, at = 'postgres store') {
  if (executor === null || typeof executor !== 'object' || typeof executor.call !== 'function') {
    throw new TypeError(`${at}: an executor with a call(fn, payload) method is required — see ADR-0010`);
  }
  return executor;
}

/**
 * createSupabaseRpcExecutor({ client }) — the deployment transport.
 *
 * The client is INJECTED. This module imports `@supabase/supabase-js` nowhere,
 * reads no environment variable, and holds no URL or key, so the runtime package
 * still contains no credential and no driver. A caller that has not configured a
 * client gets a refusal here, at construction, rather than a confusing null
 * three layers down at the first write.
 *
 * ADR-0002 stands: the client this is handed today carries the service role and
 * therefore bypasses RLS, which is why tenant safety in these adapters is
 * code-enforced on every single call and why migration 0017's tables carry no
 * client policy at all. When Path C's least-privilege role exists, the ONLY
 * change is which client is passed in — the eleven grants it needs are already
 * written, and the conformance suite already proves a role holding nothing but
 * EXECUTE can do the whole job.
 */
export function createSupabaseRpcExecutor({ client = null, schema = 'public' } = {}) {
  if (client === null || typeof client.rpc !== 'function') {
    throw new TypeError('createSupabaseRpcExecutor: a supabase-js client must be injected');
  }
  const target = schema === 'public' || typeof client.schema !== 'function' ? client : client.schema(schema);

  return Object.freeze({
    kind: 'awe_rpc_executor',
    name: 'supabase_rpc',
    async call(fn, payload) {
      if (!RPC_FUNCTIONS.includes(fn)) {
        throw new TypeError(`createSupabaseRpcExecutor: '${fn}' is not one of the durable execution functions`);
      }
      let response;
      try {
        response = await target.rpc(fn, { p: payload ?? {} });
      } catch (e) {
        // A thrown error from the client is transport, always.
        throw new StoreUnavailableError(`${fn}: ${String(e?.message ?? e)}`, { fn });
      }
      if (response?.error) {
        // PostgREST reports a raised exception here too. Both are "no answer" as
        // far as this layer is concerned: a raised exception from 0017 means a
        // malformed document, which the caller cannot fix by retrying, but it
        // also means nothing was decided — so it surfaces as unavailability
        // carrying the database's own message rather than being swallowed.
        throw new StoreUnavailableError(`${fn}: ${response.error.message ?? 'rpc failed'}`, {
          fn,
          code: response.error.code ?? null,
          hint: response.error.hint ?? null,
          details: response.error.details ?? null,
        });
      }
      return response?.data ?? null;
    },
  });
}

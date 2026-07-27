// ---------------------------------------------------------------------------
// errors.mjs — the kernel's error taxonomy.
//
// Every kernel failure carries a code from a closed vocabulary, so callers can
// branch on the CLASS of failure without string-matching messages, and runners
// can assert that a fail-closed path produced the failure it was supposed to.
// A thrown `Error` with a free-text message is not an interface; this is.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  'invalid_input',          // caller handed the kernel something unusable
  'contract_violation',     // a produced value breaks its declared contract
  'vocabulary_conflict',    // two namespaces claim the same reason differently
  'unknown_reason',         // a blocked reason outside every registered vocabulary
  'corpus_parity',          // fixture corpus and label file disagree
  'determinism_violation',  // the same input produced different bytes twice
  'verify_failed',          // a Verify Step's checks did not all pass
  'unregistered_suite',     // suite id not present in the registry
  'not_supported',          // a deliberately absent capability was requested
  'sink_failure',           // a durable artifact or audit write did not land
];

const CODES = new Set(ERROR_CODES);

export class KernelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'KernelError';
    // An unknown code is itself a bug — surface it rather than swallowing it.
    this.code = CODES.has(code) ? code : 'invalid_input';
    if (!CODES.has(code)) this.message = `[unknown error code '${code}'] ${message}`;
    this.details = details;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export function isKernelError(e, code) {
  if (!(e instanceof KernelError)) return false;
  return code === undefined || e.code === code;
}

// Guard clause with a typed failure. Reads at the call site like an assertion
// and behaves like one, but the throw is machine-classifiable.
export function invariant(condition, code, message, details = {}) {
  if (!condition) throw new KernelError(code, message, details);
  return true;
}

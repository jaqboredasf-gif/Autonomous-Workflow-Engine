// PO numbering.
//
// SAFETY RULE: every number this prototype produces is prefixed `DEMO-` and the
// prefix is a constant with no UI to change it. Issuing a number in the real
// Lippolis PO sequence requires explicit authorization from the owner and a
// decision about which system owns the counter — see the README.

export const PO_PREFIX = 'DEMO-';

/** First number handed out in the demo, per spec: DEMO-52901. */
export const FIRST_DEMO_PO_NUMBER = 52901;

export function formatPoNumber(sequence: number): string {
  return `${PO_PREFIX}${sequence}`;
}

/** Numbers increase by one, in order of generation. */
export function nextSequence(current: number): number {
  return current + 1;
}

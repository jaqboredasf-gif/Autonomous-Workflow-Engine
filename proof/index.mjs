// ---------------------------------------------------------------------------
// proof/ — can AWE prove what it accomplished?
//
// The chain this package models, end to end:
//
//   ORGANIZATIONAL PROBLEM → BASELINE → OBJECTIVE → AWE EXECUTION → RESULT
//   → OBJECTIVE SUCCESS → BUSINESS OUTCOME → VALUE → EVIDENCE → LEARNING
//
// Five modules, each owning one link, and one rule shared by all of them:
// UNKNOWN STAYS UNKNOWN. Nothing here will produce a number to fill a hole.
//
//   provenance.mjs  how do we know, and how well. Every figure is graded and
//                   sourced; derivations degrade to their weakest input.
//   baseline.mjs    what the work cost before AWE, and what one interaction
//                   with AWE costs a human now.
//   execution.mjs   what happened, in a vocabulary no capability owns. Holds
//                   the distinction between task completed and objective met.
//   value.mjs       the deep module: one execution's worth, with the tenant,
//                   baseline-version and objective gates in front of it.
//   ledger.mjs      many executions, one total, with double counting, selection
//                   bias, retries and overhead all accounted for.
//   case-study.mjs  the projection every surface reads, and `explain()`.
//
// This package is NOT about a competition, a dashboard or a pitch. It is the
// answer to a question a customer is entitled to ask on any Tuesday: what did
// this actually do for us, and how do you know?
// ---------------------------------------------------------------------------

export * from './provenance.mjs';
export * from './baseline.mjs';
export * from './execution.mjs';
export * from './value.mjs';
export * from './ledger.mjs';
export * from './case-study.mjs';
export { organizationValue, capabilitiesIn } from './organization.mjs';

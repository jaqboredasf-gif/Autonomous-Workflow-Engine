// ---------------------------------------------------------------------------
// external-readiness.mjs — what would a second organization actually need?
//
// THE QUESTION THIS ANSWERS, and it is not "is AWE configurable". It is: if a
// design partner said yes on Friday, what would we discover on Monday. That is
// a different and much more useful question, because the answer includes the
// things that are not in the profile at all.
//
// FIVE VERDICTS:
//
//   READY_GENERICALLY    the code reads it from configuration today
//   CONFIGURABLE         the value is isolated; moving it is an afternoon
//   CAPABILITY_INVARIANT deliberately not configurable. NOT a defect.
//   LIPPOLIS_SPECIFIC    the behaviour is hard-coded to how Lippolis works
//   UNKNOWN              nothing models it, so nobody has found out yet
//
// WHY THE FIFTH VERDICT WAS ADDED. The four-verdict version reported "3
// Lippolis-specific", and two of the three were deliberate design decisions:
// the quantity rule and the workflow lifecycle. Both are things a business
// wanting them different needs a DIFFERENT CAPABILITY for, not a longer
// profile — which the workflow entry's own `cost` note already said in prose
// while its verdict said the opposite.
//
// That mattered in both directions. It overstated the work (two of the three
// blockers were not work at all) and it understated the CONSTRAINT (an
// invariant narrows who can be a design partner, permanently, in a way an
// unpaid extraction does not). A blocker and a boundary are different facts and
// a founder deciding a shortlist needs to tell them apart.
//
// LIPPOLIS_SPECIFIC now means what it says: hard-coded to one customer by
// accident, and owed. It is currently EMPTY, and that is a result rather than a
// target — see `blockers` below, which no longer has anything to report.
//
// UNKNOWN IS THE MOST IMPORTANT COLUMN and the reason this file exists rather
// than a call to `extractionScore()`. The profile grades the seventeen things
// it models and is silent on everything it does not — authentication, printing,
// what a job number looks like at a business that does not use job numbers. A
// readiness report built only from the profile would score well and be wrong,
// because the expensive surprises are always in the part nobody modelled.
//
// NOTHING HERE IS BUILT YET, on purpose. This is a gap analysis: the point is
// to know what external adoption would require before choosing a partner, not
// to pre-build for a customer who does not exist.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

import { PROFILE_FIELDS } from '../../capability/purchasing/profile.mjs';

export const VERDICTS = Object.freeze([
  'READY_GENERICALLY', 'CONFIGURABLE', 'CAPABILITY_INVARIANT', 'LIPPOLIS_SPECIFIC', 'UNKNOWN',
]);

const FROM_EXTRACTABLE = Object.freeze({
  yes: 'READY_GENERICALLY',
  partial: 'CONFIGURABLE',
  no: 'LIPPOLIS_SPECIFIC',
  invariant: 'CAPABILITY_INVARIANT',
});

/**
 * The concerns a second deployment meets that the PROFILE does not model.
 *
 * Each says where it actually lives, because "unknown" without a place to look
 * is not a finding. Several are deliberately deployment concerns rather than
 * capability ones — that is the correct answer and it is worth writing down,
 * since it means they are per-installation work rather than product work.
 *
 * `owner` SAYS WHOSE UNCERTAINTY IT IS, and adding it is what let three
 * UNKNOWNs be reduced honestly. "Unknown" was doing two jobs: unknown because
 * nobody has read the code, and unknown because no second company exists yet.
 * The first is ours and can be resolved by looking; the second cannot be
 * resolved by anybody until a real business answers, and pretending otherwise
 * is how a founder ends up inventing a customer's requirements.
 *
 *   AWE       we own it. If it is UNKNOWN, somebody has not looked yet.
 *   CUSTOMER  only a real second company can answer. Legitimately open.
 *
 * So each of the three original UNKNOWNs was split: its software half was
 * resolved against the repository, and its customer half was kept and marked
 * CUSTOMER. The count of UNKNOWNs did not go down by hand-waving — it went down
 * because the AWE-owned halves were answered, and what is left is addressed to
 * a company that has not been signed.
 */
export const UNMODELLED = Object.freeze([
  {
    id: 'authentication.mode',
    verdict: 'CONFIGURABLE',
    owner: 'CUSTOMER',
    lives: 'deployment/manifest.mjs — authentication.mode is local | sso',
    means: 'PCC ships local accounts. A business on Microsoft 365 will expect to sign in with it, and nobody has built that.',
    cost: 'unknown until somebody asks for SSO; the manifest models the choice and the code implements one half of it',
  },
  {
    id: 'printing',
    verdict: 'READY_GENERICALLY',
    owner: 'AWE',
    lives: 'nowhere, and that is the answer',
    means: 'PCC has no printer setting. Approving opens the browser print dialogue on the purchase order, which prints to whatever that PC already prints to.',
    cost: 'none. A working answer rather than a placeholder — see docs/deployment/PCC_IT_DEPLOYMENT_HANDOFF.md',
  },

  // --- the three original UNKNOWNs, each split at the ownership line --------

  {
    // RESOLVED. The software question was "can PCC number a purchase order
    // without a job in it, and can its counter be scoped to something other
    // than the job-vendor pair". Both are now answered by running code:
    // `vendor-sequence` counts per vendor with no job key at all, and
    // `sequenceKeyFor` has always permitted an empty job key. Two rules behind
    // one seam is the evidence; one rule was the reason it was unknown.
    id: 'po_numbering_without_jobs',
    verdict: 'READY_GENERICALLY',
    owner: 'AWE',
    lives: 'apps/purchasing/src/purchasing/organization/po-numbering.mjs — two rules, selected by id',
    means: 'A purchase order number need not contain a job, and its counter need not be scoped by one. Proven by vendor-sequence (COOPER/1, COOPER/2 across different jobs) alongside the unchanged Lippolis rule.',
    cost: 'none for per-vendor or per-pair numbering. A third shape (per month, zero-padded, branch-prefixed) is one function and one registry line.',
  },
  {
    // PRESERVED, and narrowed to what it actually is. Numbering was the part we
    // owned. Whether the JOB CONCEPT survives at a business that does not run
    // jobs is not a code question at all: `job_number` is required on a request,
    // so a business with no jobs would have to put something there, and what
    // that something is can only come from the business.
    id: 'job_concept_survives',
    verdict: 'UNKNOWN',
    owner: 'CUSTOMER',
    lives: 'the domain — a purchase request requires a job number',
    means: 'Every request is raised against a job. A business that buys to stock, or per site, or per truck, has something else in that field, and nobody has interviewed one.',
    cost: 'unknown, and it is a QUALIFYING question rather than a build: a business with no unit of work to buy against is probably not this pilot\'s partner.',
  },
  {
    // RESOLVED. What PCC requires OF a vendor is readable: a name, a code that
    // is safe to put in an identifier and a filename, and optional contact
    // details. That was the software half and it was never unknown — nobody had
    // written it down.
    id: 'vendor_requirements',
    verdict: 'READY_GENERICALLY',
    owner: 'AWE',
    lives: 'domain/po-number.mjs (isValidVendorCode) and the vendors table; entered through Admin',
    means: 'PCC needs a vendor NAME and a short CODE (letters, digits, up to 32 characters — it goes into purchase order numbers and filenames). Contact email is needed only to draft a vendor email. Nothing else is required.',
    cost: 'none. The requirement is small and stated; a second organization enters its own list, or loads it with scripts/pcc-onboard.mjs.',
  },
  {
    // PRESERVED. Whether their commercial reality fits one row per supplier is
    // theirs to tell us.
    id: 'vendor_model_fit',
    verdict: 'UNKNOWN',
    owner: 'CUSTOMER',
    lives: 'instance data — vendors are entered through Admin',
    means: 'One vendor is one row with one code. A business buying mostly from one distributor with many branches, or through buying groups, may need branches distinguished on a purchase order.',
    cost: 'unknown until a second organization enters its own vendors. Ask for their supplier list at discovery — it is a five-minute question that de-risks the whole model.',
  },
  {
    // RESOLVED, as a KNOWN ABSENCE rather than an unknown. "Nothing imports
    // history" was never uncertain; it was unwritten. A gap with a decision
    // attached is a different object from a gap nobody has looked at, and only
    // one of them belongs in the UNKNOWN column.
    id: 'data_migration',
    verdict: 'CONFIGURABLE',
    owner: 'AWE',
    lives: 'scripts/pcc-onboard.mjs — users, jobs, vendors, assignments and PO sequences, from reviewed CSV',
    means: 'Reference data DOES load from files, including the starting purchase-order sequence per scope, which is how a paper book is continued rather than restarted. What does NOT load is open transactions: in-flight requests and unreceived orders. Deliberately OUT of pilot scope — the pilot starts on new requests and lets existing orders finish wherever they live now.',
    cost: 'none for the pilot. Importing open orders is real work and is deferred until a partner asks; it is named in the pilot definition as out of scope so it is a decision rather than a surprise.',
  },

  {
    id: 'approval_policy_shape',
    verdict: 'CONFIGURABLE',
    owner: 'CUSTOMER',
    lives: 'capability/purchasing/authorization.mjs — proven against org-002',
    means: 'Who may approve is a profile decision and was extracted; a business needing multi-step or value-threshold approval needs a different capability, not a longer profile.',
    cost: 'none for role-based approval; a threshold rule is capability work',
  },
  {
    // VERDICT CORRECTED, not the fact. Its own cost note already said this was
    // a feature; only the verdict disagreed.
    id: 'workflow_lifecycle',
    verdict: 'CAPABILITY_INVARIANT',
    owner: 'AWE',
    lives: 'the capability itself — states and transitions are not configuration',
    means: 'request to approval to order to receipt. A business that quotes before ordering, or that receives partially against blanket orders, has a different lifecycle.',
    cost: 'a different capability. This is the single largest constraint on who can be a design partner, and it is a feature rather than a defect — a configurable lifecycle is how a product becomes a rules engine nobody can test. It belongs in the QUALIFYING conversation, not the build.',
  },
  {
    id: 'multi_tenancy',
    verdict: 'READY_GENERICALLY',
    owner: 'AWE',
    lives: 'every query filters on org_id; scripts/eval-purchasing-isolation.mjs and scripts/eval-second-customer.mjs',
    means: 'One installation per organization is the deployment model, and the code is nonetheless tenant-scoped throughout — proven adversarially against a second organization\'s data, audit, proof and baselines.',
    cost: 'none',
  },
  {
    // NEW, and found by trying. A second organization wanting its OWN PRINTED
    // FORM is the one thing in this list that is genuinely bespoke code, and it
    // is small and bounded. Named so it is quoted rather than discovered.
    id: 'purchase_order_form',
    verdict: 'CONFIGURABLE',
    owner: 'CUSTOMER',
    lives: 'infrastructure/pdf-adapter.ts — PO_TEMPLATES, resolved by key, refuses an unimplemented one',
    means: 'One layout exists and it carries the organization\'s name, address and telephone number, so it is usable as-is. An organization that wants its own form is a new entry in PO_TEMPLATES: a layout object, not a rewrite.',
    cost: 'a day, and only if asked. The pilot should offer the standard form first — a custom form is the easiest thing to say yes to and the least likely to prove anything.',
  },
]);

/** What a second deployment would meet, from the profile and from what it omits. */
export function externalReadiness() {
  const fromProfile = Object.entries(PROFILE_FIELDS).map(([path, spec]) => Object.freeze({
    id: path,
    verdict: FROM_EXTRACTABLE[spec.extractable] ?? 'UNKNOWN',
    // A profile field is a promise about the CODE, so honouring it is always
    // AWE's. What VALUE the field takes is the customer's, and that is the
    // configuration contract's business rather than this report's.
    owner: 'AWE',
    lives: 'capability/purchasing/profile.mjs',
    means: spec.desc,
    required: Boolean(spec.required),
    source: 'profile',
  }));

  const all = [...fromProfile, ...UNMODELLED.map((u) => Object.freeze({ ...u, required: true, source: 'unmodelled' }))];
  const byVerdict = Object.fromEntries(VERDICTS.map((v) => [v, all.filter((x) => x.verdict === v)]));

  return Object.freeze({
    concerns: Object.freeze(all),
    byVerdict: Object.freeze(Object.fromEntries(VERDICTS.map((v) => [v, Object.freeze(byVerdict[v])]))),
    counts: Object.freeze(Object.fromEntries(VERDICTS.map((v) => [v, byVerdict[v].length]))),

    // THE ANSWER TO "COULD WE DEPLOY SOMEWHERE ELSE", in the only honest form:
    // what we would have to find out, and what we already know we would have to
    // build.
    blockers: Object.freeze(byVerdict.LIPPOLIS_SPECIFIC.map((x) => `${x.id}: ${x.means}`)),
    unknowns: Object.freeze(byVerdict.UNKNOWN.map((x) => `${x.id}: ${x.means}`)),

    // THE METRIC THAT MATTERS FOR THE NEXT CONVERSATION, split by who can
    // actually answer it.
    //
    // AWE-owned unknowns are the ones a session like this one is supposed to
    // drive to zero: they are unknown only because nobody has read the code.
    // Customer-owned unknowns cannot be driven to zero from a keyboard, and a
    // report that mixed them made the second kind look like unfinished work —
    // which invites somebody to close it by guessing what a company that has
    // not been signed would want.
    //
    // A NON-EMPTY `unknownsOwnedByAwe` IS A TO-DO LIST. A non-empty
    // `unknownsOwnedByCustomer` is a meeting agenda.
    unknownsOwnedByAwe: Object.freeze(
      byVerdict.UNKNOWN.filter((x) => x.owner === 'AWE').map((x) => `${x.id}: ${x.means}`),
    ),
    unknownsOwnedByCustomer: Object.freeze(
      byVerdict.UNKNOWN.filter((x) => x.owner !== 'AWE').map((x) => `${x.id}: ${x.means}`),
    ),

    // Every concern by owner, so the readiness gate can address a blocker to
    // somebody rather than leaving it in the passive voice.
    byOwner: Object.freeze({
      AWE: Object.freeze(all.filter((x) => x.owner === 'AWE')),
      CUSTOMER: Object.freeze(all.filter((x) => x.owner === 'CUSTOMER')),
      UNATTRIBUTED: Object.freeze(all.filter((x) => !x.owner)),
    }),

    // The constraint that most narrows who can be a partner, surfaced by name
    // because it decides the shortlist rather than the schedule.
    partnerConstraint: (() => {
      const w = UNMODELLED.find((u) => u.id === 'workflow_lifecycle');
      return `${w.means} ${w.cost}`;
    })(),

    // Deliberately NOT a percentage. Seventeen profile fields and eleven
    // unmodelled concerns are not commensurable, and averaging them would
    // produce a number that moves when somebody adds a profile field.
    summary: `${byVerdict.READY_GENERICALLY.length} ready, ${byVerdict.CONFIGURABLE.length} configurable, ` +
      `${byVerdict.CAPABILITY_INVARIANT.length} deliberately invariant, ` +
      `${byVerdict.LIPPOLIS_SPECIFIC.length} Lippolis-specific, ${byVerdict.UNKNOWN.length} unknown until somebody tries`,
  });
}

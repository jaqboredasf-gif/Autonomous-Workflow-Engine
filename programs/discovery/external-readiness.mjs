// ---------------------------------------------------------------------------
// external-readiness.mjs — what would a second organization actually need?
//
// THE QUESTION THIS ANSWERS, and it is not "is AWE configurable". It is: if a
// design partner said yes on Friday, what would we discover on Monday. That is
// a different and much more useful question, because the answer includes the
// things that are not in the profile at all.
//
// FOUR VERDICTS:
//
//   READY_GENERICALLY   the code reads it from configuration today
//   CONFIGURABLE        the value is isolated; moving it is an afternoon
//   LIPPOLIS_SPECIFIC   the behaviour is hard-coded to how Lippolis works
//   UNKNOWN             nothing models it, so nobody has found out yet
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

export const VERDICTS = Object.freeze(['READY_GENERICALLY', 'CONFIGURABLE', 'LIPPOLIS_SPECIFIC', 'UNKNOWN']);

const FROM_EXTRACTABLE = Object.freeze({
  yes: 'READY_GENERICALLY',
  partial: 'CONFIGURABLE',
  no: 'LIPPOLIS_SPECIFIC',
});

/**
 * The concerns a second deployment meets that the PROFILE does not model.
 *
 * Each says where it actually lives, because "unknown" without a place to look
 * is not a finding. Several are deliberately deployment concerns rather than
 * capability ones — that is the correct answer and it is worth writing down,
 * since it means they are per-installation work rather than product work.
 */
export const UNMODELLED = Object.freeze([
  {
    id: 'authentication.mode',
    verdict: 'CONFIGURABLE',
    lives: 'deployment/manifest.mjs — authentication.mode is local | sso',
    means: 'PCC ships local accounts. A business on Microsoft 365 will expect to sign in with it, and nobody has built that.',
    cost: 'unknown until somebody asks for SSO; the manifest models the choice and the code implements one half of it',
  },
  {
    id: 'printing',
    verdict: 'READY_GENERICALLY',
    lives: 'nowhere, and that is the answer',
    means: 'PCC has no printer setting. Approving opens the browser print dialogue on the purchase order, which prints to whatever that PC already prints to.',
    cost: 'none. A working answer rather than a placeholder — see docs/deployment/PCC_IT_DEPLOYMENT_HANDOFF.md',
  },
  {
    id: 'job_numbering',
    verdict: 'UNKNOWN',
    lives: 'instance data — jobs are entered through Admin',
    means: 'Lippolis numbers purchase orders per job and vendor. A business that does not run jobs, or numbers centrally, needs a numbering rule PCC can already express (purchasing.po_numbering) — but whether the JOB concept itself survives has never been tested.',
    cost: 'unknown. The first non-job-based business is the test, and none has been interviewed yet.',
  },
  {
    id: 'vendor_model',
    verdict: 'UNKNOWN',
    lives: 'instance data — vendors are entered through Admin',
    means: 'PCC assumes a vendor is an organization with a code and a contact. A business buying mostly from one distributor with many branches may model that differently.',
    cost: 'unknown until a second organization enters its own vendors',
  },
  {
    id: 'approval_policy_shape',
    verdict: 'CONFIGURABLE',
    lives: 'capability/purchasing/authorization.mjs — proven against org-002',
    means: 'Who may approve is a profile decision and was extracted; a business needing multi-step or value-threshold approval needs a different capability, not a longer profile.',
    cost: 'none for role-based approval; a threshold rule is capability work',
  },
  {
    id: 'workflow_lifecycle',
    verdict: 'LIPPOLIS_SPECIFIC',
    lives: 'the capability itself — states and transitions are not configuration',
    means: 'request to approval to order to receipt. A business that quotes before ordering, or that receives partially against blanket orders, has a different lifecycle.',
    cost: 'a different capability. This is the single largest constraint on who can be a design partner, and it is a feature rather than a defect — a configurable lifecycle is how a product becomes a rules engine nobody can test.',
  },
  {
    id: 'data_migration',
    verdict: 'UNKNOWN',
    lives: 'nowhere',
    means: 'Nothing imports an existing vendor list, open purchase orders or historical numbering. A business switching from a system rather than from paper will expect it.',
    cost: 'unknown, and likely the largest unbudgeted item in a second deployment',
  },
  {
    id: 'multi_tenancy',
    verdict: 'READY_GENERICALLY',
    lives: 'every query filters on org_id; scripts/eval-purchasing-isolation.mjs',
    means: 'One installation per organization is the deployment model, and the code is nonetheless tenant-scoped throughout.',
    cost: 'none',
  },
]);

/** What a second deployment would meet, from the profile and from what it omits. */
export function externalReadiness() {
  const fromProfile = Object.entries(PROFILE_FIELDS).map(([path, spec]) => Object.freeze({
    id: path,
    verdict: FROM_EXTRACTABLE[spec.extractable] ?? 'UNKNOWN',
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

    // The constraint that most narrows who can be a partner, surfaced by name
    // because it decides the shortlist rather than the schedule.
    partnerConstraint: (() => {
      const w = UNMODELLED.find((u) => u.id === 'workflow_lifecycle');
      return `${w.means} ${w.cost}`;
    })(),

    // Deliberately NOT a percentage. Seventeen profile fields and eight
    // unmodelled concerns are not commensurable, and averaging them would
    // produce a number that moves when somebody adds a profile field.
    summary: `${byVerdict.READY_GENERICALLY.length} ready, ${byVerdict.CONFIGURABLE.length} configurable, ` +
      `${byVerdict.LIPPOLIS_SPECIFIC.length} Lippolis-specific, ${byVerdict.UNKNOWN.length} unknown until somebody tries`,
  });
}

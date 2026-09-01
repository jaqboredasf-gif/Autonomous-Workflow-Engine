// ---------------------------------------------------------------------------
// readiness.mjs — CAN WE DEPLOY AWE/PCC TO THIS ORGANIZATION?
//
// One question, one deterministic answer, and every blocker addressed to
// somebody. The failure this is built against is the readiness report that says
// "configuration incomplete" and leaves a founder to work out which of thirty
// facts is missing, who can supply it, and whether waiting for it is his job or
// the customer's.
//
// THE VERDICTS, worst to best:
//
//   NOT_CONFIGURED       no dossier, or one that is not a dossier
//   CONFIG_INCOMPLETE    facts are missing. Says which, and whose they are
//   BLOCKED_BY_PRODUCT   the customer's answers need code that does not exist
//   EXTERNAL_DEPENDENCY  complete and correct, waiting on somebody else
//   READY_FOR_REHEARSAL  provisionable now, against a throwaway database
//   READY_FOR_PILOT      rehearsed, and the evidence boundary is prepared
//
// UNKNOWN IS NEVER GREEN, and this is the rule the whole module exists to
// enforce. A gate that reports READY because a required fact is absent has
// inverted its own purpose — absence is exactly the condition it was built to
// catch. So every check is written so that missing evidence produces the WORSE
// verdict, never the better one.
//
// BLOCKED_BY_PRODUCT RANKS BELOW EXTERNAL_DEPENDENCY on purpose. Waiting for a
// customer's IT department is a scheduling problem; needing a numbering rule
// nobody has written is a commitment, and it should be the more alarming word.
//
// PURE: no clock, no randomness, no I/O. The caller loads the dossier, profile,
// authorization and manifest and hands them in — so this is testable against
// deliberately broken inputs, which is the only way to know a gate refuses.
// ---------------------------------------------------------------------------

import { validateDossier, missingFacts, deploymentEnvFor } from '../../capability/purchasing/organization.mjs';
import { validateProfile } from '../../capability/purchasing/profile.mjs';

export const VERDICTS = Object.freeze([
  'NOT_CONFIGURED',
  'CONFIG_INCOMPLETE',
  'BLOCKED_BY_PRODUCT',
  'EXTERNAL_DEPENDENCY',
  'READY_FOR_REHEARSAL',
  'READY_FOR_PILOT',
]);

/** Worst verdict wins. Index in VERDICTS is severity, ascending. */
const worst = (a, b) => (VERDICTS.indexOf(a) <= VERDICTS.indexOf(b) ? a : b);

/**
 * A blocker.
 *
 * `fact` what is missing. `owner` who can supply it — AWE or CUSTOMER, never
 * the passive voice. `unlocks` what becomes possible once it exists, because a
 * blocker whose consequence is unstated gets deprioritized by whoever is busy.
 */
const blocker = (fact, owner, unlocks, detail = null) =>
  Object.freeze({ fact, owner, unlocks, ...(detail ? { detail } : {}) });

/**
 * Manifest facts nobody has answered.
 *
 * Matches the `unknown()` shape from deployment/facts.mjs (`state: 'UNKNOWN'`)
 * structurally rather than by importing its predicates, so a test can hand in a
 * plain object.
 */
export function unknownFactsIn(manifest, prefix = '', out = []) {
  for (const [k, v] of Object.entries(manifest ?? {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    if (v.state === 'UNKNOWN') {
      out.push({ path, why: String(v.reason ?? 'nobody has answered this') });
      continue;
    }
    if (v.state === 'DECLARED' || v.state === 'DERIVED') continue; // an answered fact
    unknownFactsIn(v, path, out);
  }
  return out;
}

/**
 * Assess one organization.
 *
 * @param {object} input
 * @param {object} [input.dossier]
 * @param {object} [input.profile]        loaded from dossier.profile_ref
 * @param {object} [input.authorization]  loaded from dossier.authorization_ref
 * @param {object} [input.manifest]       loaded from dossier.manifest_ref
 * @param {string[]} [input.implementedNumberingIds]  what this build can perform
 * @param {string[]} [input.implementedTemplateKeys]
 * @param {object} [input.evidence]  what has actually been DONE, not declared:
 *        { rehearsed: boolean, instanceDataPresent: boolean }
 *        Absent means not done. It is never inferred from configuration.
 */
export function designPartnerReadiness({
  dossier = null,
  profile = null,
  authorization = null,
  manifest = null,
  implementedNumberingIds = [],
  implementedTemplateKeys = [],
  evidence = {},
} = {}) {
  const blockers = [];
  let verdict = 'READY_FOR_PILOT';
  const down = (v) => { verdict = worst(verdict, v); };

  // --- is there a dossier at all ------------------------------------------
  if (!dossier || typeof dossier !== 'object' || Array.isArray(dossier)) {
    return Object.freeze({
      verdict: 'NOT_CONFIGURED',
      organization: null,
      blockers: Object.freeze([blocker('organizations/<org>/dossier.mjs', 'AWE',
        'everything — nothing can be assessed until the organization is described',
        'Copy organizations/northgate/dossier.mjs and answer it from the discovery call.')]),
      aweOwned: Object.freeze([]),
      customerOwned: Object.freeze([]),
      summary: 'no organization dossier: nothing has been configured',
    });
  }

  const orgId = dossier.organization?.id ?? null;
  const shape = validateDossier(dossier);
  const absent = missingFacts(dossier);

  // --- missing facts, attributed ------------------------------------------
  for (const m of absent) {
    blockers.push(blocker(m.fact, m.owner, m.unlocks));
    down('CONFIG_INCOMPLETE');
  }
  // Structural problems that are not simply absence — a malformed slug, a
  // timezone that is an offset, a reference that escapes the repository.
  for (const p of shape.problems.filter((x) => x.level === 'error')) {
    if (absent.some((m) => m.fact === p.path)) continue;
    blockers.push(blocker(p.path, 'AWE', 'a valid configuration', p.message));
    down('CONFIG_INCOMPLETE');
  }

  // --- the three referenced models must actually load ---------------------
  for (const [name, value, ref] of [
    ['purchasing profile', profile, dossier.profile_ref],
    ['authorization profile', authorization, dossier.authorization_ref],
    ['deployment manifest', manifest, dossier.manifest_ref],
  ]) {
    if (!value) {
      blockers.push(blocker(`${name} (${ref ?? 'unset'})`, 'AWE',
        'provisioning — a dossier that references a file nobody wrote cannot be applied'));
      down('CONFIG_INCOMPLETE');
    }
  }

  if (profile) {
    for (const p of validateProfile(profile).problems.filter((x) => x.level === 'error')) {
      blockers.push(blocker(`profile.${p.path}`, 'AWE', 'purchasing policy', p.message));
      down('CONFIG_INCOMPLETE');
    }

    // --- what the customer asked for that this build cannot do -----------
    //
    // THE PRODUCT BLOCKERS. Each is a case where the answers are complete and
    // correct and the software still cannot honour them. They are separated
    // from missing facts because the remedy is different: nobody can unblock
    // these by making a phone call.
    const numbering = profile.purchasing?.po_numbering;
    if (numbering && implementedNumberingIds.length && !implementedNumberingIds.includes(numbering)) {
      blockers.push(blocker('purchasing.po_numbering', 'AWE',
        'purchase order generation — without it the organization cannot issue an order at all',
        `"${numbering}" is not a rule this build can perform. Implemented: ${implementedNumberingIds.join(', ')}. ` +
        'Purchasing refuses rather than approximating, so this stops the pilot dead.'));
      down('BLOCKED_BY_PRODUCT');
    }
    const template = profile.documents?.po_template;
    if (template && implementedTemplateKeys.length && !implementedTemplateKeys.includes(template)) {
      blockers.push(blocker('documents.po_template', 'AWE',
        'the printed purchase order',
        `"${template}" is not a form this build can draw. Implemented: ${implementedTemplateKeys.join(', ')}. ` +
        'Offer the standard form for the pilot — it already carries their letterhead.'));
      down('BLOCKED_BY_PRODUCT');
    }
    // Lippolis's send-mode boundary is a pinned pilot decision, not a setting.
    if (profile.communications?.send_mode === 'send') {
      blockers.push(blocker('communications.send_mode', 'AWE',
        'sending vendor email directly',
        'The schema pins vendor email to draft-only and a person reviews every message. ' +
        'An organization that requires automatic sending needs capability work, and should not be the first external pilot.'));
      down('BLOCKED_BY_PRODUCT');
    }
  }

  // --- the dossier and its profile must name the same organization -------
  if (profile && shape.ok) {
    try {
      deploymentEnvFor(dossier, profile);
    } catch (err) {
      blockers.push(blocker('organization.id', 'AWE',
        'a tenant boundary that is not shared with another company', err.message));
      down('CONFIG_INCOMPLETE');
    }
  }
  if (authorization && orgId && authorization.orgId !== orgId) {
    blockers.push(blocker('authorization_ref', 'AWE',
      'authority resolution — a profile resolves capabilities only for its own organization',
      `the authorization profile is for "${authorization.orgId}", the dossier for "${orgId}". ` +
      'A membership in the wrong organization resolves to NO capabilities, so every action would be refused.'));
    down('CONFIG_INCOMPLETE');
  }

  // --- external dependencies, owned by somebody who is not us ------------
  //
  // These do not make a deployment impossible; they make it not-yet. Recorded
  // as blockers so a go-live date is not set around a fact nobody has.
  for (const { path, why } of unknownFactsIn(manifest)) {
    blockers.push(blocker(`manifest.${path}`, 'CUSTOMER',
      'a supported go-live — an unowned operational fact becomes an outage nobody answers', why));
    down('EXTERNAL_DEPENDENCY');
  }

  // --- what has actually been done ---------------------------------------
  //
  // EVIDENCE, NOT CONFIGURATION. A complete dossier means we COULD rehearse,
  // never that we HAVE. Defaulting these to false is the whole discipline: an
  // unanswered question about whether something was done is answered "no".
  if (!evidence.instanceDataPresent) {
    blockers.push(blocker('instance data (users, jobs, vendors, PO sequences)', 'CUSTOMER',
      'a pilot anybody can sign in to and use',
      'The dossier names a directory; nothing has been loaded from it. Run scripts/pcc-onboard.mjs --dry-run.'));
    down('READY_FOR_REHEARSAL');
  }
  if (!evidence.rehearsed) {
    blockers.push(blocker('a completed second-organization rehearsal', 'AWE',
      'READY_FOR_PILOT — deploying to a real company on a path nobody has walked is how a go-live becomes a debugging session',
      'Run: node scripts/eval-second-customer.mjs'));
    down('READY_FOR_REHEARSAL');
  }
  if (dossier.proof?.baseline_state !== 'FROZEN') {
    blockers.push(blocker('proof.baseline_state', 'CUSTOMER',
      'any CLAIM about what the pilot saved. Deployment does not need it; a case study does',
      `currently ${dossier.proof?.baseline_state ?? 'unset'}. Only the customer can produce the old process's numbers, ` +
      'and they have to be frozen BEFORE production records start or the comparison is unfalsifiable.'));
    // Deliberately does NOT reduce the verdict below READY_FOR_PILOT: a pilot
    // can be deployed and be useful without a frozen baseline. What it cannot
    // do is produce a case study, and the blocker says so instead of blocking.
  }

  return Object.freeze({
    verdict,
    organization: orgId,
    blockers: Object.freeze(blockers),
    /** Blockers we can close ourselves, this week, without anybody's help. */
    aweOwned: Object.freeze(blockers.filter((b) => b.owner === 'AWE')),
    /** Blockers only the customer can close. The agenda for the next call. */
    customerOwned: Object.freeze(blockers.filter((b) => b.owner === 'CUSTOMER')),
    summary: `${orgId ?? 'unnamed'}: ${verdict} — ${blockers.length} blocker(s), ` +
      `${blockers.filter((b) => b.owner === 'AWE').length} ours, ` +
      `${blockers.filter((b) => b.owner === 'CUSTOMER').length} theirs`,
  });
}

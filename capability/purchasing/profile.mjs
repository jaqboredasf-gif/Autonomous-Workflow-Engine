// ---------------------------------------------------------------------------
// profile.mjs — how one organization's purchasing differs from another's.
//
// PCC works at Lippolis. This module is the beginning of the answer to "what
// would have to change for it to work somewhere else", and it is deliberately
// small: it models only variation the PCC implementation actually demonstrates,
// plus the handful of things the next trades business will obviously differ on.
//
// NOT A RULES ENGINE. There is no DSL, no conditions, no scripting. A profile
// is a small record of choices; anything that needs real logic stays in code
// where it can be read and tested.
//
// WHAT IS NOT HERE, on purpose:
//   · secrets — those are deployment configuration, see deployment/manifest.mjs
//   · the workflow itself — the states and transitions are the CAPABILITY, not
//     a per-customer setting. A business that needs a different purchasing
//     lifecycle needs a different capability, not a longer profile.
//   · vendor and job records — instance DATA, entered through the application
// ---------------------------------------------------------------------------

/**
 * The fields, with what varies and what may not.
 *
 * `extractable` records the honest state of the implementation TODAY:
 *   'yes'        the code already reads this from configuration
 *   'partial'    the value is isolated but still reached through a constant
 *   'no'         the behaviour is hard-coded in the capability. EXTRACTION DEBT.
 *   'invariant'  DELIBERATELY not configurable. Not debt, and never will be.
 *
 * WHY 'invariant' EXISTS, and it is not a softer word for 'no'. The column had
 * four states and conflated two different facts: "nobody has extracted this
 * yet" and "this is the capability and must not be extracted". The quantity rule
 * `max(needed - stock, 0)` was marked 'no', so every readiness report counted a
 * deliberate design decision as a Lippolis-specific assumption and as a debt
 * somebody ought to pay. Both readings are false, and the second is worse: it
 * invites a future session to "fix" an invariant by making it configurable.
 *
 * The test of which one a field is: would honouring it for a second
 * organization be WORK, or would it be a DIFFERENT PRODUCT? Work is debt. A
 * different product is an invariant.
 *
 * A field marked 'no' is still a promise the code does not keep, and pretending
 * otherwise is worse than not having the field.
 */
export const PROFILE_FIELDS = {
  'organization.id':               { required: true,  extractable: 'yes',     desc: 'Slug.' },
  'organization.name':             { required: true,  extractable: 'yes',     desc: 'Prints on the purchase order. Already read from PCC_ORG_NAME.' },

  // --- what things are called ----------------------------------------------
  // Lippolis says "workshop". Another business says "yard", "shop", "store".
  // The WORD is presentation; the CONCEPT — an internal place holding stock
  // that reduces what must be bought — is the capability.
  'terminology.stock_location':    { required: true,  extractable: 'partial', desc: 'Lippolis: "workshop". A label, not a concept. The ROLE-name half is extracted (authorization.mjs) and the SCREEN-LABEL half is now read from PCC_STOCK_LOCATION_LABEL (organization/identity.mjs, terminology). Still partial: the reserved delivery-location kind and several route names carry the word.' },
  'terminology.request_noun':      { required: false, extractable: 'partial', desc: 'Lippolis: "request".' },

  // --- who may do what ------------------------------------------------------
  // The ROLE NAMES are currently a closed vocabulary in domain/roles.mjs.
  // Which real people hold them is instance data; which roles exist is not yet
  // configurable, and that is the largest single piece of extraction debt.
  // EXTRACTED. An organization defines its own role names and what each one may
  // do (capability/purchasing/authorization.mjs); purchasing consumes the
  // resolved capabilities and never learns the names. Proven against a second
  // organization whose roles share no name with these — see
  // scripts/eval-organization-provisioning.mjs.
  'roles.approvers':               { required: true,  extractable: 'yes',     desc: 'Roles carrying review.decide / po.generate.' },
  'roles.orderers':                { required: true,  extractable: 'yes',     desc: 'Roles carrying order.mark_ordered.' },
  'roles.receivers':               { required: true,  extractable: 'yes',     desc: 'Roles carrying receiving.record. Still assignment-scoped per job.' },

  // --- purchasing policy ----------------------------------------------------
  'purchasing.po_numbering':       { required: true,  extractable: 'yes',     desc: 'The id of the organization\'s numbering strategy. Read by the composition root, which selects the implementation; an id nobody has implemented stops startup rather than inventing numbers. Lippolis: job-vendor-sequence, per pair, from 1.' },
  'purchasing.po_separator':       { required: false, extractable: 'yes',     desc: 'Lippolis: "-". EXTRACTED. Read from PCC_PO_SEPARATOR, passed to the numbering strategy, and validated against a closed allowlist — a character this build will not print in an identifier is refused rather than swapped for a hyphen (organization/po-numbering.mjs, requireSeparator).' },
  'purchasing.quantity_rule':      { required: true,  extractable: 'invariant', desc: 'order = max(needed - stock, 0). A CAPABILITY INVARIANT, not debt: a business wanting different arithmetic here means something else by "purchasing". Reclassified from \'no\' — it was never unextracted work, and counting it as such labelled a design decision as a defect.' },
  'purchasing.default_fulfilment_days': { required: false, extractable: 'yes', desc: 'Lippolis: 1 — next day. EXTRACTED to organization policy: system_settings.default_fulfilment_days, set from PCC_DEFAULT_FULFILMENT_DAYS at creation, and consumed by the request form as the default need-by date. NULL means the organization has stated no expectation and the field starts blank, which is what it did before.' },
  'purchasing.overdue_rule':       { required: false, extractable: 'partial', desc: 'Lippolis: past need-by and still needing purchasing.' },
  'purchasing.requires_cost_at_order': { required: false, extractable: 'yes', desc: 'Lippolis: no — accounting reconciles from the invoice.' },

  // --- documents and communication -----------------------------------------
  'documents.po_template':         { required: true,  extractable: 'yes',     desc: 'Read from system_settings.po_template_key and RESOLVED through an explicit registry that refuses a form it cannot draw (pdf-adapter.ts, poTemplateFor). Previously the declared key was stamped onto a document drawn from the default layout — a false provenance record. One layout exists (awe_default, aliased as lippolis_default); a second organization wanting its own PRINTED FORM is bounded custom work, and is classified as such rather than as configuration.' },
  'communications.vendor_channel': { required: true,  extractable: 'yes',     desc: 'email | none.' },
  'communications.send_mode':      { required: true,  extractable: 'partial', desc: 'draft-only | send. Lippolis: draft-only, pinned by a CHECK constraint.' },

  // --- where it runs --------------------------------------------------------
  'deployment.manifest_ref':       { required: true,  extractable: 'yes',     desc: 'Path to the deployment manifest. The two models meet here and nowhere else.' },
};

export const PROFILE_PATHS = Object.keys(PROFILE_FIELDS);

const at = (profile, path) => path.split('.').reduce((n, k) => (n == null ? undefined : n[k]), profile);

/**
 * Structural validation, plus the check that matters most: a profile must not
 * contain a secret, and must not silently omit a required choice.
 */
export function validateProfile(profile) {
  const problems = [];
  const add = (level, path, message) => problems.push({ level, path, message });

  if (!profile || typeof profile !== 'object') {
    return { ok: false, problems: [{ level: 'error', path: '', message: 'profile is not an object' }] };
  }
  for (const [path, spec] of Object.entries(PROFILE_FIELDS)) {
    const value = at(profile, path);
    if (spec.required && (value === undefined || value === null || value === '')) {
      add('error', path, 'is required and has not been set');
    }
  }
  // Deployment configuration lives in the manifest. A profile carrying a
  // hostname or a secret means the two models have started to merge, which is
  // how a purchasing setting ends up gating a deployment.
  const walk = (node, prefix) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string' && /secret|password|token|api[_-]?key/i.test(k)) {
        add('error', path, 'looks like a credential — profiles are configuration, not secrets');
      }
      if (typeof v === 'object') walk(v, path);
    }
  };
  walk(profile, '');
  return { ok: problems.every((p) => p.level !== 'error'), problems };
}

/**
 * What this profile asks for that the code cannot yet honour.
 *
 * The honest measure of extraction progress: a profile is only as real as the
 * number of its fields the capability actually reads.
 */
export function extractionDebt(profile) {
  const debt = [];
  for (const [path, spec] of Object.entries(PROFILE_FIELDS)) {
    // An invariant is not debt. Reporting it as such is how a design decision
    // gets "paid off" by a future session that did not know it was one.
    if (spec.extractable === 'yes' || spec.extractable === 'invariant') continue;
    const value = at(profile, path);
    if (value === undefined || value === null) continue;
    debt.push({ path, extractable: spec.extractable, value, note: spec.desc });
  }
  return debt;
}

/**
 * How much of a profile the capability genuinely honours today.
 *
 * INVARIANTS ARE EXCLUDED FROM THE DENOMINATOR, and that is the honest
 * arithmetic rather than the flattering one. A deliberate invariant is not
 * configuration the code fails to honour — it is configuration that must not
 * exist — so scoring it as unhonoured measures the product against a design it
 * deliberately rejected. It is reported as its own count so the exclusion is
 * visible and cannot be mistaken for the number getting better on its own.
 */
export function extractionScore() {
  const all = Object.values(PROFILE_FIELDS);
  const yes = all.filter((f) => f.extractable === 'yes').length;
  const partial = all.filter((f) => f.extractable === 'partial').length;
  const hardCoded = all.filter((f) => f.extractable === 'no').length;
  const invariant = all.filter((f) => f.extractable === 'invariant').length;
  const configurable = all.length - invariant;
  return {
    total: all.length,
    honoured: yes,
    partial,
    hardCoded,
    /** Deliberately not configurable. Not debt. */
    invariant,
    /** The fields for which "honoured" is even a meaningful question. */
    configurable,
    // Partial counts as a half: the value is isolated in one place and moving
    // it is an afternoon, not a refactor.
    percent: configurable === 0 ? 100 : Math.round(((yes + partial * 0.5) / configurable) * 100),
  };
}

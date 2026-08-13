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
 *   'yes'      the code already reads this from configuration
 *   'partial'  the value is isolated but still reached through a constant
 *   'no'       the behaviour is currently hard-coded in the capability
 *
 * That column is extraction debt, stated rather than implied. A profile field
 * marked 'no' is a promise the code does not yet keep, and pretending otherwise
 * is worse than not having the field.
 */
export const PROFILE_FIELDS = {
  'organization.id':               { required: true,  extractable: 'yes',     desc: 'Slug.' },
  'organization.name':             { required: true,  extractable: 'yes',     desc: 'Prints on the purchase order. Already read from PCC_ORG_NAME.' },

  // --- what things are called ----------------------------------------------
  // Lippolis says "workshop". Another business says "yard", "shop", "store".
  // The WORD is presentation; the CONCEPT — an internal place holding stock
  // that reduces what must be bought — is the capability.
  'terminology.stock_location':    { required: true,  extractable: 'partial', desc: 'Lippolis: "workshop". A label, not a concept. The ROLE-name half of this coupling is now extracted; the reserved-location and UI-label half is not.' },
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
  'purchasing.po_numbering':       { required: true,  extractable: 'partial', desc: 'Lippolis: job-vendor-sequence, per pair, from 1.' },
  'purchasing.po_separator':       { required: false, extractable: 'partial', desc: 'Lippolis: "-". One constant in domain/po-number.mjs.' },
  'purchasing.quantity_rule':      { required: true,  extractable: 'no',      desc: 'order = max(needed - stock, 0). Proven; not configurable, and probably should not be.' },
  'purchasing.default_fulfilment_days': { required: false, extractable: 'no', desc: 'Lippolis: next day. Currently an assumption in the UI copy, not a value.' },
  'purchasing.overdue_rule':       { required: false, extractable: 'partial', desc: 'Lippolis: past need-by and still needing purchasing.' },
  'purchasing.requires_cost_at_order': { required: false, extractable: 'yes', desc: 'Lippolis: no — accounting reconciles from the invoice.' },

  // --- documents and communication -----------------------------------------
  'documents.po_template':         { required: true,  extractable: 'partial', desc: 'Lippolis: their own form. One LAYOUT object in the PDF adapter.' },
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
    if (spec.extractable === 'yes') continue;
    const value = at(profile, path);
    if (value === undefined || value === null) continue;
    debt.push({ path, extractable: spec.extractable, value, note: spec.desc });
  }
  return debt;
}

/** How much of a profile the capability genuinely honours today. */
export function extractionScore() {
  const all = Object.values(PROFILE_FIELDS);
  const yes = all.filter((f) => f.extractable === 'yes').length;
  const partial = all.filter((f) => f.extractable === 'partial').length;
  return {
    total: all.length,
    honoured: yes,
    partial,
    hardCoded: all.filter((f) => f.extractable === 'no').length,
    // Partial counts as a half: the value is isolated in one place and moving
    // it is an afternoon, not a refactor.
    percent: Math.round(((yes + partial * 0.5) / all.length) * 100),
  };
}

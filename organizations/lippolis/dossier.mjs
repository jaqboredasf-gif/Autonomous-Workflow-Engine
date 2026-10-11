// ---------------------------------------------------------------------------
// organizations/lippolis/dossier.mjs — organization #1, described.
//
// NOTHING HERE CHANGES PCC. Lippolis was deployed before the dossier existed,
// and this file states what is already true about that installation in the
// contract a SECOND customer will be provisioned through.
//
// WHY DESCRIBE A DEPLOYMENT THAT ALREADY WORKS. Because a provisioning contract
// that has only ever been used to create the thing it was designed around
// proves nothing. If the dossier cannot express organization #1 — the one whose
// real behaviour is known in detail — it is a form, not a contract. Deriving
// Lippolis's environment from this file and comparing it against the .env the
// installation actually runs on is the test that the contract is complete, and
// it is asserted in scripts/eval-second-customer.mjs.
// ---------------------------------------------------------------------------

export const lippolisDossier = {
  organization: {
    id: 'lippolis',
    legal_name: 'Lippolis Electric, Inc.',
    // Their own shorthand, and the reason the field exists: derived from the
    // legal name this would be "Lippolis Electric", and every screen has said
    // "Lippolis" since the first day somebody used it.
    short_name: 'Lippolis',
    address: 'Licensed Electrical Contractor · 25 Seventh Street, Pelham, NY 10803',
    phone: '(914) 738-3550',
    timezone: 'America/New_York',
    // Their own artwork, which is why the field is optional rather than absent:
    // Lippolis has a mark and Northgate does not, and both must work.
    logo_path: '/brand/lippolis-logo.svg',
    logo_fallback_path: '/brand/lippolis-logo.png',
  },

  profile_ref: 'capability/purchasing/profiles/lippolis.mjs',
  authorization_ref: 'capability/purchasing/profiles/lippolis-authorization.mjs',
  manifest_ref: 'deployment/examples/pcc.manifest.mjs',

  instance_data: {
    dir: 'config/onboarding',
  },

  proof: {
    baseline_id: 'lippolis_purchasing_v0',
    // NOT FROZEN, and this is the honest state rather than a placeholder. The
    // baseline needs observations Jack has to collect at Lippolis; until then
    // Case Study #001 is NOT_READY and says so. See proof/baselines/.
    baseline_state: 'COLLECTING',
    observation_state: 'NOT_OPENED',
  },

  pilot: {
    scope: 'purchasing-materials',
    success_measure: 'the office stops keeping a parallel paper record of what was ordered',
    exit_criteria: 'thirty days of production use, or the office asking to stop',
  },
};

export default lippolisDossier;

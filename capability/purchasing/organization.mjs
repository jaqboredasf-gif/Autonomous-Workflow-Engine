// ---------------------------------------------------------------------------
// organization.mjs — ONE file per customer, and the only file per customer.
//
// WHAT PROBLEM THIS SOLVES. Before this, standing up an organization meant
// knowing about four unrelated things and keeping them consistent by memory:
//
//   capability/purchasing/profiles/<org>.mjs                purchasing policy
//   capability/purchasing/profiles/<org>-authorization.mjs  roles
//   deployment/examples/<org>.manifest.mjs                  where it runs
//   a .env file                                             what the app reads
//
// Nothing checked that they agreed, and they did not: the synthetic second
// organization existed as `org-002-trades` in one file and `org-002-synthetic`
// in another, with the first pointing at the second's manifest. Two names for
// one company, in the artifacts whose whole purpose is to identify it. That is
// not a typo — it is what happens when the same fact is written in four places.
//
// A DOSSIER IS THE ONE PLACE. It names the organization once, references the
// three models, adds the facts none of them held (proof namespace, pilot scope,
// instance-data location), and DERIVES the environment the application reads —
// so the .env cannot disagree with the profile, because nobody writes it twice.
//
// DESIGN IT TWICE, and what was rejected:
//
//   A. COPY AND CUSTOMIZE the Lippolis deployment for each customer. Rejected:
//      it is the customer-fork pattern with extra steps. Every copy starts
//      correct and diverges, no test can tell a deliberate difference from a
//      stale one, and the second customer's bug fix does not reach the first.
//
//   B. ONE CANONICAL PRODUCT LINE, with per-organization CONFIGURATION and a
//      declared boundary for what configuration may not do. Chosen. A customer
//      difference lives in a dossier if it is genuinely a customer difference,
//      and in code if it is genuinely capability behaviour — and the profile's
//      `extractable`/`invariant` column is what forces that decision to be made
//      out loud rather than by whoever is typing.
//
// WHAT A DOSSIER MAY NOT DO, and these are the boundaries that keep it from
// becoming a rules engine or a security hole:
//
//   · NO CODE. Values only — strings, numbers, booleans, arrays of strings.
//     No functions, no template strings evaluated later, no `require`, no
//     paths that get executed. A dossier is read, never run.
//   · NO SECRETS. Not a password, not a token, not a connection string with
//     one in it. Dossiers are committed; secrets are deployment configuration
//     and live in the manifest's secret store as references.
//   · NO LIFECYCLE. The states and transitions are the capability. A dossier
//     cannot add a step, skip one, or reorder them.
//   · NO NEW CAPABILITIES. A role may be given any capability the domain
//     defines and none that it does not.
//
// PURE: no clock, no randomness, no I/O. Reading a dossier from disk is the
// provisioning script's job (scripts/provision-organization.mjs).
// ---------------------------------------------------------------------------

import { validateProfile, PROFILE_FIELDS } from './profile.mjs';
import { defineAuthorizationProfile } from './authorization.mjs';

/** Organization ids are slugs, permanently. Baselines are written against them. */
export const ORG_ID_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

/**
 * Anything whose NAME looks like a credential. Matched on the key rather than
 * the value, because a value that looks random may be a vendor code and a value
 * that looks harmless may be a password.
 */
const SECRET_KEY = /secret|password|passwd|token|api[_-]?key|credential|private[_-]?key|connection[_-]?string|dsn/i;

/** Values a dossier may contain. Deliberately short. */
const isScalar = (v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null;

/**
 * The pilot scopes AWE will actually offer a design partner.
 *
 * A CLOSED SET, because "what are we piloting" is a decision and an open text
 * field is how it becomes a negotiation. `purchasing-materials` is the only one
 * today: the workflow proven at Lippolis, offered whole.
 */
export const PILOT_SCOPES = Object.freeze(['purchasing-materials']);

/**
 * What state a design partner's evidence is in. Mirrors the proof architecture
 * rather than restating it — a dossier records which of these applies, and
 * `proof/` decides what may be claimed from it.
 */
export const BASELINE_STATES = Object.freeze(['NOT_STARTED', 'COLLECTING', 'FROZEN']);
export const OBSERVATION_STATES = Object.freeze(['NOT_OPENED', 'OPEN', 'CLOSED']);

/**
 * The fields, what they are for, and who can answer them.
 *
 * `owner` is the point of this table. A readiness gate that says "configuration
 * incomplete" is useless; one that says "we are waiting on the customer for
 * three facts and on ourselves for none" is a plan. AWE-owned gaps are ours to
 * close before a partner says yes; CUSTOMER-owned gaps are the agenda for the
 * technical discovery call and cannot be closed by guessing.
 */
export const DOSSIER_FIELDS = Object.freeze({
  'organization.id':            { required: true,  owner: 'CUSTOMER', unlocks: 'everything — it is the tenant boundary and it is permanent' },
  'organization.legal_name':    { required: true,  owner: 'CUSTOMER', unlocks: 'the purchase order letterhead' },
  'organization.short_name':    { required: false, owner: 'CUSTOMER', unlocks: 'screen titles; derived from the legal name if omitted' },
  'organization.address':       { required: true,  owner: 'CUSTOMER', unlocks: 'the purchase order letterhead — suppliers post to it' },
  'organization.phone':         { required: true,  owner: 'CUSTOMER', unlocks: 'the purchase order letterhead — suppliers ring it' },
  'organization.timezone':      { required: true,  owner: 'CUSTOMER', unlocks: 'need-by dates, overdue bands, and every timestamp a person reads' },
  // OPTIONAL, and deliberately so. An organization that has supplied no artwork
  // gets a text wordmark of its own name — a real answer, not a placeholder —
  // so no pilot is ever blocked on somebody locating a vector file.
  'organization.logo_path':     { required: false, owner: 'CUSTOMER', unlocks: 'their own mark on every screen; unset renders a wordmark of their name' },

  'profile_ref':                { required: true,  owner: 'AWE',      unlocks: 'purchasing policy — the numbering rule, the separator, the fulfilment expectation' },
  'authorization_ref':          { required: true,  owner: 'AWE',      unlocks: 'who may do what. Written by AWE FROM the customer\'s answers' },
  'manifest_ref':               { required: true,  owner: 'AWE',      unlocks: 'the deployment — hosting, storage, TLS, who restarts it' },

  'instance_data.dir':          { required: true,  owner: 'CUSTOMER', unlocks: 'users, jobs, vendors, assignments and starting PO sequences (scripts/pcc-onboard.mjs)' },

  'proof.baseline_id':          { required: true,  owner: 'AWE',      unlocks: 'measurement. Organization-scoped, so it cannot be confused with another company\'s' },
  'proof.baseline_state':       { required: true,  owner: 'CUSTOMER', unlocks: 'whether a saving may be CLAIMED. Only the customer can produce the old process\'s numbers' },
  'proof.observation_state':    { required: true,  owner: 'AWE',      unlocks: 'whether production records count as evidence yet' },

  'pilot.scope':                { required: true,  owner: 'AWE',      unlocks: 'what is being offered, and what is explicitly not' },
  'pilot.success_measure':      { required: true,  owner: 'CUSTOMER', unlocks: 'what "it worked" means to THEM. Agreed before deployment or it is decided afterwards by whoever is unhappiest' },
  'pilot.exit_criteria':        { required: true,  owner: 'CUSTOMER', unlocks: 'how the pilot ends. A pilot with no end is a free deployment' },
});

const at = (o, path) => path.split('.').reduce((n, k) => (n == null ? undefined : n[k]), o);

/**
 * Structural validation.
 *
 * AGGRESSIVE ON PURPOSE, and it reports every problem rather than the first:
 * this runs on a founder's laptop before a provisioning run, and being told one
 * mistake at a time is how a five-minute job becomes an afternoon.
 */
export function validateDossier(dossier) {
  const problems = [];
  const add = (level, path, message) => problems.push({ level, path, message });

  if (!dossier || typeof dossier !== 'object' || Array.isArray(dossier)) {
    return { ok: false, problems: [{ level: 'error', path: '', message: 'a dossier must be an object' }] };
  }

  // --- required facts, each attributed to whoever can supply it ------------
  for (const [path, spec] of Object.entries(DOSSIER_FIELDS)) {
    const value = at(dossier, path);
    const empty = value === undefined || value === null || value === '' ||
      (Array.isArray(value) && value.length === 0);
    if (spec.required && empty) {
      add('error', path, `is required and has not been set — ${spec.owner} owns this fact; it unlocks ${spec.unlocks}`);
    }
  }

  // --- the tenant boundary ------------------------------------------------
  const id = at(dossier, 'organization.id');
  if (id !== undefined && id !== null && id !== '') {
    if (typeof id !== 'string' || !ORG_ID_PATTERN.test(id)) {
      add('error', 'organization.id',
        `must be a slug: lowercase letters, digits, hyphen or underscore, starting with a letter, 2-64 characters (got ${JSON.stringify(id)}). ` +
        'It is permanent — baselines, frozen case studies and a restored backup all identify the tenant by it.');
    }
    // A NAME THAT IS ANOTHER CUSTOMER'S. Cheap to check, and the failure it
    // prevents is copying a dossier and forgetting the one field that matters.
    if (typeof id === 'string' && RESERVED_ORG_IDS.includes(id) && at(dossier, 'organization.legal_name') &&
        !String(at(dossier, 'organization.legal_name')).toLowerCase().includes(id)) {
      add('error', 'organization.id',
        `"${id}" is an existing organization's id but the legal name does not match it. ` +
        'This is what a copied dossier looks like: change the id, or the two organizations will share a tenant boundary.');
    }
  }

  // --- timezone -----------------------------------------------------------
  const tz = at(dossier, 'organization.timezone');
  if (tz) {
    if (typeof tz !== 'string' || !/^[A-Za-z]+\/[A-Za-z_+-]+/.test(tz)) {
      add('error', 'organization.timezone',
        `must be an IANA zone name such as "America/New_York" (got ${JSON.stringify(tz)}). ` +
        'An offset is not enough: it is wrong for half the year, and "overdue" is computed from it.');
    }
  }

  // --- enumerations, refused rather than defaulted -------------------------
  const enums = [
    ['pilot.scope', PILOT_SCOPES],
    ['proof.baseline_state', BASELINE_STATES],
    ['proof.observation_state', OBSERVATION_STATES],
  ];
  for (const [path, allowed] of enums) {
    const v = at(dossier, path);
    if (v !== undefined && v !== null && v !== '' && !allowed.includes(v)) {
      add('error', path, `must be one of ${allowed.join(', ')} (got ${JSON.stringify(v)})`);
    }
  }

  // --- references are paths, and they are not executed --------------------
  for (const path of ['profile_ref', 'authorization_ref', 'manifest_ref', 'instance_data.dir']) {
    const v = at(dossier, path);
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') { add('error', path, 'must be a repository-relative path'); continue; }
    // A REFERENCE THAT ESCAPES THE REPOSITORY. A dossier is committed and then
    // fed to a script that resolves these; `../../../etc` and an absolute path
    // are both how a config file becomes a way to read something it should not.
    if (v.startsWith('/') || v.includes('..')) {
      add('error', path, `must be a repository-relative path without ".." (got ${JSON.stringify(v)})`);
    }
  }

  // --- no code, no secrets, anywhere at any depth -------------------------
  const walk = (node, prefix, depth) => {
    if (depth > 8) { add('error', prefix, 'is nested more deeply than a dossier has any reason to be'); return; }
    for (const [k, v] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'function') {
        add('error', path, 'is a function. A dossier is DATA and is never executed — behaviour belongs in the capability, where it can be read and tested.');
        continue;
      }
      if (SECRET_KEY.test(k)) {
        add('error', path, 'names a credential. Dossiers are committed to source: secrets are deployment configuration and belong in the manifest\'s secret store, by reference.');
        continue;
      }
      if (isScalar(v)) continue;
      if (Array.isArray(v)) {
        v.forEach((item, i) => {
          if (isScalar(item)) return;
          if (item && typeof item === 'object' && !Array.isArray(item)) return walk(item, `${path}[${i}]`, depth + 1);
          add('error', `${path}[${i}]`, 'may only contain values or plain objects');
        });
        continue;
      }
      if (v && typeof v === 'object') { walk(v, path, depth + 1); continue; }
      add('error', path, `is not a value a dossier may hold (${typeof v})`);
    }
  };
  walk(dossier, '', 0);

  return { ok: problems.every((p) => p.level !== 'error'), problems };
}

/**
 * Organization ids already in use, so a copied dossier is caught by name.
 *
 * A LIST RATHER THAN A SCAN. Reading the filesystem would make validation
 * impure and would still miss an organization deployed from another checkout.
 * The real uniqueness guarantee is the tenant boundary in the database; this is
 * the cheap check that catches the mistake people actually make.
 */
export const RESERVED_ORG_IDS = Object.freeze(['lippolis']);

/**
 * What the DEPLOYMENT must set, derived from the dossier.
 *
 * THE POINT OF DERIVING RATHER THAN WRITING. Every value below was previously
 * typed a second time into a .env file, where nothing compared it to the
 * profile it was supposed to match. An organization whose profile said
 * `vendor-sequence` and whose .env said `job-vendor-sequence` would start,
 * work, and number its purchase orders by the rule nobody chose.
 *
 * SECRETS ARE NOT HERE, and their absence is asserted by test. SESSION_SECRET
 * and any database credential come from the manifest's secret store at install
 * time; this function's output is safe to print, commit and paste into a ticket.
 *
 * @param {object} dossier
 * @param {object} profile   the loaded purchasing profile (`profile_ref`)
 * @returns {Record<string,string>} env, sorted, values as strings
 */
export function deploymentEnvFor(dossier, profile, authorization = null) {
  const v = validateDossier(dossier);
  if (!v.ok) {
    throw new Error(
      'refusing to derive an environment from an invalid dossier:\n  ' +
        v.problems.filter((p) => p.level === 'error').map((p) => `${p.path}: ${p.message}`).join('\n  '),
    );
  }
  const p = validateProfile(profile);
  if (!p.ok) {
    throw new Error(
      `refusing to derive an environment from an invalid purchasing profile (${dossier.profile_ref}):\n  ` +
        p.problems.filter((x) => x.level === 'error').map((x) => `${x.path}: ${x.message}`).join('\n  '),
    );
  }
  // THE AGREEMENT CHECK. Two files name the organization; if they disagree, one
  // of them is a copy somebody forgot to finish, and this is the last moment
  // anybody looks before a tenant is created under the wrong id — permanently.
  if (profile.organization?.id !== dossier.organization.id) {
    throw new Error(
      `the dossier and its purchasing profile name different organizations: ` +
        `dossier "${dossier.organization.id}", profile "${profile.organization?.id}" (${dossier.profile_ref}). ` +
        'One of them is a copied file. The id is the tenant boundary and it is permanent.',
    );
  }

  const env = {
    PCC_ORG_ID: dossier.organization.id,
    PCC_ORG_NAME: dossier.organization.legal_name,
    PCC_ORG_ADDRESS: dossier.organization.address,
    PCC_ORG_PHONE: dossier.organization.phone,
    PCC_PO_NUMBERING: profile.purchasing.po_numbering,
    TZ: dossier.organization.timezone,
  };
  if (dossier.organization.short_name) env.PCC_ORG_SHORT_NAME = dossier.organization.short_name;
  if (dossier.organization.logo_path) env.PCC_ORG_LOGO = dossier.organization.logo_path;
  if (dossier.organization.logo_fallback_path) env.PCC_ORG_LOGO_FALLBACK = dossier.organization.logo_fallback_path;
  if (profile.purchasing.po_separator) env.PCC_PO_SEPARATOR = profile.purchasing.po_separator;
  if (profile.documents?.po_template) env.PCC_PO_TEMPLATE = profile.documents.po_template;
  if (profile.purchasing.default_fulfilment_days !== undefined && profile.purchasing.default_fulfilment_days !== null) {
    env.PCC_DEFAULT_FULFILMENT_DAYS = String(profile.purchasing.default_fulfilment_days);
  }
  if (profile.terminology?.stock_location) env.PCC_STOCK_LOCATION_LABEL = profile.terminology.stock_location;
  if (profile.terminology?.request_noun) env.PCC_REQUEST_NOUN = profile.terminology.request_noun;

  // THE ORGANIZATION'S ROLE VOCABULARY, derived rather than typed.
  //
  // `user_roles.role_key` has a foreign key to a `roles` table, so a role name
  // the installation has never registered cannot be stored — which is why a
  // second organization used to need an edit to seed.ts. The names come from
  // the authorization profile, which is the only place they are declared, so
  // the two cannot drift.
  if (authorization?.roleNames?.length) {
    env.PCC_ROLE_VOCABULARY = [...authorization.roleNames].sort().join(',');
  }

  return Object.freeze(Object.fromEntries(
    Object.entries(env).sort(([a], [b]) => a.localeCompare(b)).map(([k, val]) => [k, String(val)]),
  ));
}

/**
 * Every fact still missing, addressed to whoever owns it.
 *
 * This is what the readiness gate reports. A blocker without an owner is a
 * blocker nobody is working on.
 */
export function missingFacts(dossier) {
  const out = [];
  for (const [path, spec] of Object.entries(DOSSIER_FIELDS)) {
    const value = dossier ? at(dossier, path) : undefined;
    const empty = value === undefined || value === null || value === '' ||
      (Array.isArray(value) && value.length === 0);
    if (!spec.required || !empty) continue;
    out.push(Object.freeze({ fact: path, owner: spec.owner, unlocks: spec.unlocks }));
  }
  return Object.freeze(out);
}

/**
 * The authorization profile a dossier's role answers become.
 *
 * A thin pass-through to `defineAuthorizationProfile`, which already refuses an
 * unknown capability at construction. It exists so the dossier layer has one
 * entry point and so the orgId agreement is checked here too.
 */
export function authorizationFor(dossier, authorization) {
  if (authorization.orgId !== dossier.organization.id) {
    throw new Error(
      `the dossier and its authorization profile name different organizations: ` +
        `"${dossier.organization.id}" and "${authorization.orgId}" (${dossier.authorization_ref}).`,
    );
  }
  return authorization;
}

/** Fields the profile grades, re-exported so a dossier author has one import. */
export const PROFILE_FIELD_PATHS = Object.freeze(Object.keys(PROFILE_FIELDS));
export { defineAuthorizationProfile };

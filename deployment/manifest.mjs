// ---------------------------------------------------------------------------
// manifest.mjs — the deployment manifest: schema, validation, derivation.
//
// One manifest describes one (organization, application) deployment. It states
// INTENT and holds no secrets: a field that needs one holds a REFERENCE to
// where the value lives.
//
// The schema is a flat table keyed by dotted path. Flat because the interesting
// operations — which fields are unknown, which block deployment, who owns each
// one — are all iterations over fields, and a nested walk buys nothing for a
// document this size.
//
// WHAT DECIDES WHETHER A FIELD BELONGS HERE. It must materially change how the
// deployment is performed for PCC, or plausibly for the second organization.
// Fields invented for a customer AWE does not have are how a manifest becomes a
// form nobody fills in honestly.
// ---------------------------------------------------------------------------

import { derived, isKnown, toFact, unknown } from './facts.mjs';
import { RESPONSIBILITY_DOMAINS } from './responsibilities.mjs';

/** @typedef {'required'|'optional'|'derived'|'secret-ref'} FieldClass */

/**
 * THE FIELD TABLE.
 *
 * `blocks` names the earliest phase the deployment cannot pass without this —
 * see blockers.mjs. `owner` is a responsibility domain, not a person: PCC has
 * a Jose, and the next organization may have an MSP, a hosting provider, or
 * nobody at all.
 */
export const FIELDS = {
  // --- who this is for ------------------------------------------------------
  'organization.id':   { class: 'required', blocks: 'REQUIRED_BEFORE_BUILD', owner: 'AWE', desc: 'Short slug; namespaces everything.' },
  'organization.name': { class: 'required', blocks: 'REQUIRED_BEFORE_GO_LIVE', owner: 'APPLICATION_OWNER', desc: 'Appears on customer-facing output.' },

  // --- what is being deployed ----------------------------------------------
  'application.id':      { class: 'required', blocks: 'REQUIRED_BEFORE_BUILD', owner: 'AWE', desc: 'Application slug.' },
  'application.version': { class: 'required', blocks: 'REQUIRED_BEFORE_DEPLOY', owner: 'AWE', desc: 'Tag or commit actually deployed.' },
  'application.repository': { class: 'optional', blocks: 'NON_BLOCKING', owner: 'AWE', desc: 'Source. Absent for an artifact-only delivery.' },

  // --- runtime --------------------------------------------------------------
  // A hard version floor is the cheapest deployment blocker to check and one of
  // the most expensive to discover late: PCC needs Node >=24 because its
  // datastore is part of the runtime, and a locked-down host cannot run it.
  'runtime.name':        { class: 'required', blocks: 'REQUIRED_BEFORE_BUILD', owner: 'AWE', desc: 'e.g. node.' },
  'runtime.min_version': { class: 'required', blocks: 'REQUIRED_BEFORE_BUILD', owner: 'AWE', desc: 'Hard floor. Not a preference.' },

  // --- where it runs --------------------------------------------------------
  'hosting.environment':   { class: 'required', blocks: 'REQUIRED_BEFORE_DEPLOY', owner: 'CUSTOMER_IT', desc: 'on-prem-vm | customer-cloud | managed-platform | awe-hosted.' },
  'hosting.os':            { class: 'required', blocks: 'REQUIRED_BEFORE_DEPLOY', owner: 'CUSTOMER_IT', desc: 'linux | windows. Decides the service adapter.' },
  'hosting.admin_access':  { class: 'required', blocks: 'REQUIRED_BEFORE_DEPLOY', owner: 'CUSTOMER_IT', desc: 'Can a service be installed?' },
  'hosting.install_path':  { class: 'optional', blocks: 'REQUIRED_BEFORE_DEPLOY', owner: 'CUSTOMER_IT', desc: 'Where the application lives. Disposable.' },
  'hosting.cpu':           { class: 'derived',  blocks: 'NON_BLOCKING', owner: 'AWE', desc: 'From architecture, not from what is available.' },
  'hosting.memory_gb':     { class: 'derived',  blocks: 'NON_BLOCKING', owner: 'AWE', desc: '' },
  'hosting.disk_gb':       { class: 'derived',  blocks: 'NON_BLOCKING', owner: 'AWE', desc: 'Driven by attachment and backup growth, not record size.' },

  // --- the only thing that is not disposable --------------------------------
  'storage.data_path':  { class: 'required', blocks: 'REQUIRED_BEFORE_DEPLOY', owner: 'CUSTOMER_IT', desc: 'Absolute. The one directory that must outlive the release.' },
  'storage.filesystem': { class: 'required', blocks: 'REQUIRED_BEFORE_DEPLOY', owner: 'CUSTOMER_IT', desc: 'local | network. Network is a hazard for embedded stores.' },
  'storage.backed_up_by_customer': { class: 'optional', blocks: 'REQUIRED_BEFORE_GO_LIVE', owner: 'BACKUPS', desc: 'Is this volume already in backup scope?' },

  // --- how people reach it --------------------------------------------------
  'network.hostname':      { class: 'required', blocks: 'REQUIRED_BEFORE_GO_LIVE', owner: 'DNS', desc: 'Internal FQDN. Becomes the application base URL.' },
  'network.exposure':      { class: 'required', blocks: 'REQUIRED_BEFORE_GO_LIVE', owner: 'CUSTOMER_IT', desc: 'internal | vpn | public.' },
  'network.port':          { class: 'optional', blocks: 'REQUIRED_BEFORE_DEPLOY', owner: 'CUSTOMER_IT', desc: 'Application listen port.' },
  'network.reverse_proxy': { class: 'optional', blocks: 'REQUIRED_BEFORE_GO_LIVE', owner: 'CUSTOMER_IT', desc: 'The application terminates nothing.' },
  'network.tls_owner':     { class: 'required', blocks: 'REQUIRED_BEFORE_GO_LIVE', owner: 'TLS', desc: 'Who holds the certificate.' },

  // --- state ----------------------------------------------------------------
  'database.engine':          { class: 'required', blocks: 'REQUIRED_BEFORE_BUILD', owner: 'AWE', desc: 'sqlite | postgres.' },
  'database.location':        { class: 'required', blocks: 'REQUIRED_BEFORE_DEPLOY', owner: 'DATABASE', desc: 'Path or connection reference.' },
  'database.migrations_mode': { class: 'derived',  blocks: 'NON_BLOCKING', owner: 'AWE', desc: 'on-startup | explicit-command.' },
  'database.backup_destination': { class: 'optional', blocks: 'REQUIRED_BEFORE_GO_LIVE', owner: 'BACKUPS', desc: '' },

  // --- keeping it running ---------------------------------------------------
  'service.manager':          { class: 'derived',  blocks: 'REQUIRED_BEFORE_DEPLOY', owner: 'CUSTOMER_IT', desc: 'systemd | docker-compose | windows-service. Derived from OS unless declared.' },
  'service.restart_policy':   { class: 'optional', blocks: 'NON_BLOCKING', owner: 'AWE', desc: '' },
  'service.enabled_at_boot':  { class: 'required', blocks: 'REQUIRED_BEFORE_GO_LIVE', owner: 'CUSTOMER_IT', desc: 'Survives a reboot without a human.' },

  // --- who gets in ----------------------------------------------------------
  'authentication.mode':     { class: 'required', blocks: 'REQUIRED_BEFORE_GO_LIVE', owner: 'IDENTITY', desc: 'local | sso.' },
  'authentication.provider': { class: 'optional', blocks: 'NON_BLOCKING', owner: 'IDENTITY', desc: 'Only when mode is sso.' },

  // --- the outside world ----------------------------------------------------
  'integrations.email_mode':               { class: 'optional', blocks: 'NON_BLOCKING', owner: 'APPLICATION_OWNER', desc: 'draft-only | smtp | graph | none.' },
  'integrations.outbound_network_required': { class: 'derived', blocks: 'NON_BLOCKING', owner: 'AWE', desc: 'Whether anything is called at runtime.' },

  // --- running it -----------------------------------------------------------
  'operations.health_readiness': { class: 'derived',  blocks: 'NON_BLOCKING', owner: 'AWE', desc: '' },
  'operations.health_liveness':  { class: 'derived',  blocks: 'NON_BLOCKING', owner: 'AWE', desc: 'Opposite remedy from readiness.' },
  'operations.monitoring':       { class: 'optional', blocks: 'NON_BLOCKING', owner: 'MONITORING', desc: 'Something that can poll a URL.' },
  'operations.restart_owner':    { class: 'required', blocks: 'REQUIRED_BEFORE_GO_LIVE', owner: 'CUSTOMER_IT', desc: 'Who acts when it stops. Asked least, matters most.' },

  // --- measurement: the facts that cannot be fixed after first start --------
  //
  // Both are written into the database when it is CREATED and never again, so
  // getting either wrong is not a configuration mistake that somebody corrects
  // next week — it is a permanent property of the installation's records. They
  // belong in this model for exactly the reason the letterhead does.
  'measurement.environment': {
    class: 'required', blocks: 'REQUIRED_BEFORE_DEPLOY', owner: 'AWE',
    desc: 'production | rehearsal | development. Stamped once, at database creation. Anything but production is refused as evidence, and a real install that forgets is refused too.',
  },
  'measurement.org_id_declared': {
    class: 'required', blocks: 'REQUIRED_BEFORE_DEPLOY', owner: 'AWE',
    desc: 'Is PCC_ORG_ID set? Undeclared means a generated UUID, which no baseline can be written against in advance and which a restore does not reproduce.',
  },
  'measurement.baseline_registered': {
    class: 'optional', blocks: 'NON_BLOCKING', owner: 'AWE',
    desc: 'Is a proof baseline registered for this organization id? Not a go-live blocker — PCC works without measurement — but until it is true nothing the deployment does can be valued.',
  },

  // --- secrets: references only --------------------------------------------
  'secrets.store':          { class: 'required',   blocks: 'REQUIRED_BEFORE_DEPLOY', owner: 'CREDENTIALS', desc: 'Where secret values live. Not a value.' },
  'secrets.session_secret': { class: 'secret-ref', blocks: 'REQUIRED_BEFORE_DEPLOY', owner: 'CREDENTIALS', desc: 'Reference only.' },
};

/** Every field path, for iteration. */
export const FIELD_PATHS = Object.keys(FIELDS);

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * A secret-ref must NAME a location, never carry a value.
 *
 * Accepted shapes: `secret-ref:<anything>`, `env:VAR_NAME`, or an absolute path
 * to a store. Anything else is treated as a leaked value, because the failure
 * mode of guessing wrong in the other direction — a real secret committed to a
 * repository — is not recoverable by editing the file afterwards.
 */
const SECRET_REF_SHAPES = [/^secret-ref:/i, /^env:[A-Z_][A-Z0-9_]*$/, /^\/[^\s]+$/];

export function isSecretReference(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  return SECRET_REF_SHAPES.some((re) => re.test(value.trim()));
}

/**
 * Does this look like somebody pasted an actual secret?
 *
 * TWO RULES, and the second one is narrow on purpose.
 *
 * The first — known key prefixes — is high precision and does the real work.
 *
 * The second is an entropy heuristic, and the first version of it flagged
 * PCC's own version string, `main@0038-po-number-per-job-vendor`, as a leaked
 * secret. That is precisely the failure this whole substrate exists to prevent:
 * a check condemning legitimate customer data because it superficially
 * resembles something bad (see Deployment Invariant 4). Caught by the test
 * suite, in the code written to encode the lesson.
 *
 * So the heuristic now excludes anything carrying the structure of an ordinary
 * value — a path, a URL, an address, a version, a hyphenated identifier — and
 * fires only on the shape an opaque token actually has: long, mixed case, with
 * digits, and no structural separators at all.
 */
export function looksLikeSecretValue(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (isSecretReference(v)) return false;

  // High precision: these prefixes are not ordinary values.
  if (/^(sk|pk|ghp|gho|xox[baprs]|AKIA|eyJ)[-_A-Za-z0-9]{8,}/.test(v)) return true;

  // Structure means it is a value somebody wrote, not a token a machine minted.
  if (/[\s/@:.]/.test(v)) return false;
  return v.length >= 24 && /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Read a dotted path out of a manifest as a fact. Never throws. */
export function factAt(manifest, path) {
  const raw = path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), manifest);
  if (raw === undefined) return unknown(`${path} has not been provided`);
  return toFact(raw, `manifest:${manifest?.organization?.id ?? 'unknown'}`);
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Facts AWE can work out from other facts.
 *
 * Deliberately few. Every derivation is a guess dressed as knowledge, and the
 * only ones here are those where being wrong is immediately visible — a service
 * manager that does not exist fails at install, loudly.
 *
 * A derivation NEVER overwrites a declared or verified value. If the customer
 * said `docker-compose` on Linux, they are describing their machine; AWE is
 * inferring about it.
 */
export const DERIVATIONS = {
  'service.manager': (m) => {
    const os = factAt(m, 'hosting.os');
    const env = factAt(m, 'hosting.environment');
    if (!isKnown(os)) return null;
    if (isKnown(env) && env.value === 'managed-platform') {
      return derived('platform-managed', 'hosting.environment=managed-platform');
    }
    if (os.value === 'linux') return derived('systemd', 'hosting.os=linux');
    if (os.value === 'windows') return derived('windows-service', 'hosting.os=windows');
    return null;
  },
};

/**
 * Apply every derivation whose inputs are known, without disturbing anything
 * stronger. Returns a NEW resolved view — the manifest is not mutated, so the
 * file on disk stays the record of what somebody actually declared.
 */
export function resolve(manifest) {
  const facts = {};
  for (const path of FIELD_PATHS) facts[path] = factAt(manifest, path);

  for (const [path, derive] of Object.entries(DERIVATIONS)) {
    const current = facts[path];
    if (current.state === 'DECLARED' || current.state === 'VERIFIED') continue;
    const next = derive(manifest);
    if (next) facts[path] = next;
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Structural problems with the manifest itself — as distinct from facts that
 * are merely unknown, which is blockers.mjs's business.
 *
 * Returns problems rather than throwing: a half-filled manifest early in
 * discovery is the normal case, and refusing to look at it would make the tool
 * useless exactly when it is most needed.
 */
export function validateManifest(manifest) {
  const problems = [];
  const add = (level, path, message) => problems.push({ level, path, message });

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, problems: [{ level: 'error', path: '', message: 'manifest is not an object' }] };
  }
  if (manifest.manifest_version === undefined) {
    add('error', 'manifest_version', 'missing — a manifest must say which contract it follows');
  }

  // SECRETS. The one rule with no exceptions.
  for (const [path, spec] of Object.entries(FIELDS)) {
    const fact = factAt(manifest, path);
    if (!isKnown(fact)) continue;
    if (spec.class === 'secret-ref') {
      if (!isSecretReference(fact.value)) {
        add('error', path, 'is a secret reference and must name where the value lives (secret-ref:… / env:VAR / an absolute path) — never the value itself');
      }
    } else if (looksLikeSecretValue(fact.value)) {
      add('error', path, 'looks like a secret value. Manifests are committed; move it to the secret store and reference it');
    }
  }

  // Unknown fields: a typo silently does nothing, which is worse than an error.
  const known = new Set(FIELD_PATHS);
  const walk = (node, prefix) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (['manifest_version', 'responsibilities', 'notes'].includes(path)) continue;
      if (known.has(path)) continue;
      if (value && typeof value === 'object' && !Array.isArray(value) && !('state' in value)) walk(value, path);
      else add('warning', path, 'is not a field this contract knows about — check the spelling');
    }
  };
  walk(manifest, '');

  // Responsibility domains must be ones the model recognises.
  for (const [domain, owner] of Object.entries(manifest.responsibilities ?? {})) {
    if (!RESPONSIBILITY_DOMAINS.includes(domain)) {
      add('warning', `responsibilities.${domain}`, 'is not a known responsibility domain');
    }
    if (owner === undefined || owner === null || owner === '') {
      add('warning', `responsibilities.${domain}`, 'has no owner — UNKNOWN is a valid answer and should be written down');
    }
  }

  return { ok: problems.every((p) => p.level !== 'error'), problems };
}

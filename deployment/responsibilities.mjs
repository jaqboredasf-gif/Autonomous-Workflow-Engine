// ---------------------------------------------------------------------------
// responsibilities.mjs — who does what, stated rather than assumed.
//
// PCC has a Jose. Every operational artifact written for it quietly assumes one
// person who can install a service, edit DNS, hold a certificate, run backups
// and be called at 7am. That is one organization's staffing, not a property of
// deployment, and the next organization may have an MSP, a hosting provider, a
// technical founder doing it between other jobs, or nobody at all.
//
// So responsibility is configuration. This is operational metadata — who to ask
// — and deliberately NOT a permissions engine. Its whole job is to make a
// handoff explicit and to let a blocker report name the party that can clear it,
// instead of addressing everything to "IT".
//
// UNKNOWN is a legitimate answer and is the default. An unowned domain is a real
// finding: it is how "nobody is actually going to run the backups" becomes
// visible before go-live rather than after the first failure.
// ---------------------------------------------------------------------------

/**
 * The domains that had a distinct owner during the PCC deployment, or that
 * plainly would at an organization shaped differently. Each one is here because
 * it can be owned by a DIFFERENT party from the others — that is the test for
 * belonging on this list.
 */
export const RESPONSIBILITY_DOMAINS = [
  'APPLICATION',      // the software itself: builds, releases, defects
  'INFRASTRUCTURE',   // the server or platform it runs on
  'DATABASE',         // the datastore, where it is separate from the app
  'DNS',              // the hostname record
  'NETWORK',          // firewall, routing, VPN
  'TLS',              // certificates and termination
  'IDENTITY',         // accounts, SSO, directory
  'BACKUPS',          // schedule, retention, offsite
  'MONITORING',       // is anybody watching
  'CREDENTIALS',      // secret storage and rotation
  'DEPLOYMENT_APPROVAL', // who says it may go live
];

/** Who can hold a domain. Coarse on purpose — this names a party, not a person. */
export const RESPONSIBILITY_OWNERS = [
  'AWE',
  'CUSTOMER_IT',
  'MSP',
  'HOSTING_PROVIDER',
  'APPLICATION_OWNER',
  'SHARED',
  'UNKNOWN',
];

/** Everything unowned. The honest starting point for a new organization. */
export function emptyResponsibilities() {
  return Object.fromEntries(RESPONSIBILITY_DOMAINS.map((d) => [d, 'UNKNOWN']));
}

/** Fill in what a manifest declares, leaving the rest explicitly UNKNOWN. */
export function resolveResponsibilities(manifest) {
  const declared = manifest?.responsibilities ?? {};
  const out = emptyResponsibilities();
  for (const domain of RESPONSIBILITY_DOMAINS) {
    const owner = declared[domain];
    if (owner && RESPONSIBILITY_OWNERS.includes(owner)) out[domain] = owner;
  }
  return out;
}

/**
 * Domains nobody owns.
 *
 * Not automatically a blocker — an internal pilot can genuinely run without a
 * monitoring owner. Which unowned domains block go-live is a policy decision
 * (see evidence.mjs), not a fact about the domain.
 */
export function unownedDomains(manifest) {
  const resolved = resolveResponsibilities(manifest);
  return RESPONSIBILITY_DOMAINS.filter((d) => resolved[d] === 'UNKNOWN');
}

/**
 * Who should be asked to clear a blocker on this field.
 *
 * Falls back to the schema's default owner for the field, then to UNKNOWN —
 * which is itself worth reporting, because a blocker nobody owns is how a
 * deployment stalls without anybody noticing they were waiting for each other.
 */
export function ownerFor(manifest, fieldSpec) {
  const resolved = resolveResponsibilities(manifest);
  const domain = FIELD_OWNER_TO_DOMAIN[fieldSpec?.owner] ?? null;
  if (domain && resolved[domain] && resolved[domain] !== 'UNKNOWN') return resolved[domain];
  // The schema's `owner` may already name a party rather than a domain.
  if (RESPONSIBILITY_OWNERS.includes(fieldSpec?.owner)) return fieldSpec.owner;
  return 'UNKNOWN';
}

/** Schema field owners that name a DOMAIN rather than a party. */
const FIELD_OWNER_TO_DOMAIN = {
  DNS: 'DNS',
  TLS: 'TLS',
  DATABASE: 'DATABASE',
  BACKUPS: 'BACKUPS',
  MONITORING: 'MONITORING',
  IDENTITY: 'IDENTITY',
  CREDENTIALS: 'CREDENTIALS',
  CUSTOMER_IT: 'INFRASTRUCTURE',
  APPLICATION_OWNER: 'APPLICATION',
};

// ---------------------------------------------------------------------------
// organization/identity.mjs — whose installation is this, for the chrome.
//
// THE BLOCKER THIS REMOVES. Twenty-four page titles said "Lippolis Purchasing"
// as string literals, and the root layout said "Lippolis Electric — Purchasing
// Control Center". Every one of them is a source-code edit a second customer
// would have required before their staff could look at a screen without another
// company's name on it — which is the exact shape of blocker the second-customer
// work exists to eliminate. The names were never a decision; they were the
// first customer's name typed where a value belonged.
//
// WHY ENV AND NOT THE DATABASE. These are `metadata` exports in Next server
// modules: static, evaluated once, no request and no `await`. Reading the
// organization row would make every page's title an async database call to
// render text the installation already knows about itself before it starts. The
// deployment declares its own identity in `PCC_ORG_NAME` — the same variable
// the purchase order letterhead comes from — so chrome and paperwork cannot
// disagree.
//
// WHAT THIS IS NOT: tenant resolution. One installation serves one
// organization; that is the deployment model (see AWE_DEPLOYMENT_MODEL.md) and
// it is why an env var is the right source. A future installation serving many
// organizations resolves identity per request and does not use this file.
// ---------------------------------------------------------------------------

/**
 * The product's own name. AWE's, not a customer's, and deliberately not
 * configurable — an organization buys Purchasing Control Center; it does not
 * rename it.
 */
export const PRODUCT_NAME = 'Purchasing Control Center';
export const PRODUCT_SHORT_NAME = 'Purchasing';

/**
 * The legal suffixes a title drops.
 *
 * "Northgate Mechanical Ltd. Purchasing" reads like a mistake. The letterhead
 * needs the legal name and a browser tab does not, so a short form is derived
 * rather than demanded — an organization that dislikes the derivation sets
 * PCC_ORG_SHORT_NAME and the derivation is not consulted.
 */
const LEGAL_SUFFIX = /[,\s]+(inc|inc\.|incorporated|llc|l\.l\.c\.|ltd|ltd\.|limited|corp|corp\.|corporation|co|co\.|company|plc|lp|llp|pty|gmbh|s\.a\.|b\.v\.)$/i;

/** The short form of a company name, for chrome. Pure. */
export function shortNameOf(name) {
  let out = String(name ?? '').trim();
  // Twice: "Foo Holdings Co., Ltd." carries two.
  for (let i = 0; i < 2; i++) out = out.replace(LEGAL_SUFFIX, '').trim();
  return out || String(name ?? '').trim();
}

/**
 * This installation's organization identity, for display only.
 *
 * NO FALLBACK TO A COMPANY NAME. An installation that has not declared one is
 * described by the product's name, never by the first customer's: a screen
 * headed "Lippolis" at a business that is not Lippolis is a defect a reader
 * cannot distinguish from a data leak. `bootstrap.ts` is where an undeclared
 * identity is actually REFUSED, at the moment it becomes permanent; here the
 * honest display is the generic one.
 */
export function organizationIdentity(env = process.env) {
  const legalName = String(env.PCC_ORG_NAME ?? '').trim();
  const declaredShort = String(env.PCC_ORG_SHORT_NAME ?? '').trim();
  const shortName = declaredShort || (legalName ? shortNameOf(legalName) : '');
  return Object.freeze({
    id: String(env.PCC_ORG_ID ?? '').trim(),
    legalName,
    shortName,
    declared: Boolean(legalName),
  });
}

/**
 * A page title: `Receiving — Northgate Mechanical Purchasing`.
 *
 * Undeclared, it is `Receiving — Purchasing Control Center`. Generic, correct,
 * and nobody else's company.
 */
export function pageTitle(page, env = process.env) {
  const { shortName } = organizationIdentity(env);
  const suffix = shortName ? `${shortName} ${PRODUCT_SHORT_NAME}` : PRODUCT_NAME;
  const label = String(page ?? '').trim();
  return label ? `${label} — ${suffix}` : suffix;
}

/** The root document title: `Northgate Mechanical — Purchasing Control Center`. */
export function appTitle(env = process.env) {
  const { shortName } = organizationIdentity(env);
  return shortName ? `${shortName} — ${PRODUCT_NAME}` : PRODUCT_NAME;
}

// ---------------------------------------------------------------------------
// TERMINOLOGY.
//
// Lippolis says "workshop": the internal place that holds stock and therefore
// reduces what has to be bought. Another business says yard, shop, store,
// warehouse. The CONCEPT is the capability and is not configurable; the WORD is
// presentation and was written into screen labels as a literal.
//
// This is the label half of `terminology.stock_location` in the organization
// profile. The ROLE-name half was extracted earlier (authorization.mjs).
// ---------------------------------------------------------------------------

/** Lippolis's words, which are the defaults because they are the ones proven. */
export const DEFAULT_TERMINOLOGY = Object.freeze({
  stockLocation: 'workshop',
  requestNoun: 'request',
});

/**
 * This installation's words.
 *
 * Defaults are Lippolis's, so an installation that says nothing reads exactly
 * as it does today. A second organization sets the two variables.
 */
export function terminology(env = process.env) {
  return Object.freeze({
    stockLocation: String(env.PCC_STOCK_LOCATION_LABEL ?? '').trim() || DEFAULT_TERMINOLOGY.stockLocation,
    requestNoun: String(env.PCC_REQUEST_NOUN ?? '').trim() || DEFAULT_TERMINOLOGY.requestNoun,
  });
}

// ---------------------------------------------------------------------------
// BRANDING.
//
// The logo was a hard-coded path to Lippolis's artwork and the company name was
// a string literal in the brand lockup, the mobile chrome's aria-label, and the
// sign-in copy. A second organization's staff would have signed in under
// another company's mark, and no amount of configuration could have changed it.
//
// NO ARTWORK IS REQUIRED. An organization that has not supplied a logo gets a
// TEXT WORDMARK of its own short name, which is a real answer rather than a
// placeholder: it is legible, it is correct, and it does not block a pilot on
// somebody finding a vector file. Lippolis supplies its own and looks exactly
// as it does today.
// ---------------------------------------------------------------------------

/**
 * The organization's logo, or null.
 *
 * `PCC_ORG_LOGO` is a path under the application's public directory. It is
 * validated as a same-origin path rather than trusted: this value lands in an
 * `src` attribute, and a configuration value that can become `javascript:` or a
 * third-party URL is a way to get script or a tracker onto every screen.
 */
export function brandLogo(env = process.env) {
  const declared = String(env.PCC_ORG_LOGO ?? '').trim();
  if (!declared) return null;
  if (!declared.startsWith('/') || declared.startsWith('//') || /[\r\n]/.test(declared)) return null;
  const fallback = String(env.PCC_ORG_LOGO_FALLBACK ?? '').trim();
  return {
    src: declared,
    fallbackSrc: fallback.startsWith('/') && !fallback.startsWith('//') ? fallback : null,
  };
}

/** Everything the chrome needs to identify the installation. One import. */
export function branding(env = process.env) {
  const { shortName, legalName, declared } = organizationIdentity(env);
  return Object.freeze({
    shortName: shortName || PRODUCT_NAME,
    legalName: legalName || PRODUCT_NAME,
    declared,
    logo: brandLogo(env),
    productName: PRODUCT_NAME,
  });
}

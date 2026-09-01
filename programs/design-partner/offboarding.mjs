// ---------------------------------------------------------------------------
// offboarding.mjs — how a design partner stops, safely.
//
// A PRODUCT THAT CANNOT BE LEFT IS NOT A PRODUCT. A pilot whose exit is
// undefined is one whose exit gets improvised on the day somebody is annoyed,
// and improvisation with a database is how evidence disappears.
//
// GOVERNED DISABLE AND ARCHIVE. NOT DELETION. The purchase orders PCC issued
// went to real suppliers and were reconciled against real invoices; the audit
// trail records things people really did. A business that leaves may still be
// asked about all of it by an auditor, an insurer or a lawyer for years, and the
// fact that they stopped using the software does not make those records ours to
// destroy. So nothing here deletes a record, and the one step that touches data
// at all is a step somebody has to ask for in writing.
//
// WHAT THIS MODULE IS: the ordered procedure, with an owner and a reversibility
// note on each step. It performs nothing — every action is either an existing
// command or a thing a person does — because an offboarding script that runs
// unattended is a loaded gun pointed at a customer's records.
//
// PURE: no clock, no randomness, no I/O.
// ---------------------------------------------------------------------------

export const REVERSIBILITY = Object.freeze(['REVERSIBLE', 'IRREVERSIBLE']);

const step = (n, action, owner, reversibility, how, why) =>
  Object.freeze({ n, action, owner, reversibility, how, why });

/**
 * The procedure, in order.
 *
 * THE ORDER IS THE SAFETY. Access is revoked first, because that is what the
 * customer actually asked for and it is completely reversible. Anything touching
 * data comes last and only on request, by which time nobody is in a hurry.
 */
export const OFFBOARDING = Object.freeze([
  step(1, 'Agree in writing what happens to the records',
    'AWE', 'REVERSIBLE',
    'One email: access ends on this date; records are retained and readable by us until they ask otherwise; here is what an export would contain.',
    'This is the only step that cannot be added afterwards. Everything below is mechanical once it is answered.'),

  step(2, 'Disable every account',
    'AWE', 'REVERSIBLE',
    'node scripts/pcc-reset-admin.mjs is NOT this. Set is_active = 0 for every user in the organization through Administration, or one statement on the server.',
    'This is what "stop" means to a customer: nobody can sign in. It destroys nothing and is undone by setting the flag back — proven in scripts/eval-second-customer.mjs.'),

  step(3, 'Stop the service and disable it at boot',
    'CUSTOMER_IT_OR_MSP', 'REVERSIBLE',
    'Whoever owns the host — see the manifest\'s operations.restart_owner. On Windows, the service; on Linux, systemctl disable --now.',
    'A running application nobody may sign in to is a patch surface with no user. It is their host and therefore their step.'),

  step(4, 'Take a final backup and verify it restores',
    'AWE', 'REVERSIBLE',
    'node scripts/pcc-backup.mjs, then bash scripts/restore-rehearsal.sh against the copy.',
    'A backup nobody has restored is a belief. This is the last moment the running system exists to check it against.'),

  step(5, 'Revoke the credentials',
    'CREDENTIALS_OWNER', 'IRREVERSIBLE',
    'Rotate SESSION_SECRET and any database credential in the secret store named by the manifest\'s secrets.store. Never in the dossier — a dossier holds no secret, which is asserted by validateDossier.',
    'Sessions outlive disabled accounts until the signing secret changes. Irreversible by design: a revoked secret is the point.'),

  step(6, 'Mark the organization archived in its dossier',
    'AWE', 'REVERSIBLE',
    'Set proof.observation_state to CLOSED. Leave the baseline state as it truly was — a baseline that was never frozen was never frozen.',
    'So a later reader knows the production window is shut and no further records will arrive, without having to infer it from the absence of new ones.'),

  step(7, 'Close the evidence window rather than deleting the evidence',
    'AWE', 'REVERSIBLE',
    'The proof layer already scopes every record to the organization and the period. A closed window stops new records counting; it does not remove old ones.',
    'What was measured was measured. Deleting it because the relationship ended would make every remaining claim unverifiable, including the honest ones.'),

  step(8, 'Export or destroy their data — ONLY if they ask, in writing',
    'AWE', 'IRREVERSIBLE',
    'There is deliberately no command for this. It is a manual act, performed once, against a named written request, after step 4.',
    'THE ONLY IRREVERSIBLE STEP THAT TOUCHES RECORDS, and it is not automated on purpose. A delete command that exists gets run by accident; one that does not exist cannot be.'),
]);

/** Steps that can be undone. Most of them, which is the design. */
export const reversibleSteps = () => OFFBOARDING.filter((s) => s.reversibility === 'REVERSIBLE');
export const irreversibleSteps = () => OFFBOARDING.filter((s) => s.reversibility === 'IRREVERSIBLE');

/**
 * What offboarding must never do. Asserted by test, so a future session adding
 * a convenient `--purge` flag fails rather than ships.
 */
export const OFFBOARDING_INVARIANTS = Object.freeze([
  'no step deletes a purchase order, a receipt, an audit record or a history line',
  'no step is performed automatically, on a schedule, or as a side effect of anything else',
  'access is revoked before anything touches data, because revoking access is what was asked for',
  'the only irreversible steps are rotating a secret and an explicitly requested export or destruction',
  'a final backup is verified by restoring it, while the system still exists to compare against',
]);

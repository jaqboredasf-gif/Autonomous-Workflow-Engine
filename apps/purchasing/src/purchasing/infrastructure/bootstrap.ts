/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// bootstrap.ts — what a database contains on a PRODUCTION first start.
//
// THE DEFECT THIS EXISTS TO CLOSE, stated plainly because it is the worst one
// this application has had:
//
// `seed()` runs on any empty database, and it creates the pilot cast — ten
// accounts including `admin@example.invalid` with the ADMIN role — each with
// the password `Purchasing!2026`, which is written in seed.ts, in the README,
// and in this repository. Nothing about it is conditional on the environment.
//
// So the first production container to start against an empty volume came up
// with a published administrator password. Anybody who could reach the URL
// could sign in as an administrator, read every purchase order, invite
// themselves a user and change the PO sequence. Verified by doing it against
// the built image before this file existed.
//
// The demo cast is not wrong — it is what makes the pilot demonstrable, and
// the eval suites sign in as those people. It is wrong IN PRODUCTION, so that
// is where it is refused.
//
// WHAT A PRODUCTION DATABASE GETS INSTEAD
//
//   the organization           named by PCC_ORG_NAME
//   the roles                  the same six; they are structure, not data
//   the email templates        editable copies of the built-in wording
//   the workshop + office      the two destinations that are not job sites
//   the request sequence  (purchase order numbers need no counter to seed —
//                          each job-and-vendor pair counts from 1 on its own)
//   ONE administrator          from PCC_BOOTSTRAP_ADMIN_EMAIL/_PASSWORD
//
// No vendors, no jobs, no people. Those are the company's, they are entered
// through Admin, and inventing them would mean Mike deleting somebody's
// imaginary suppliers before he could enter his own.
//
// If no bootstrap administrator is configured, the database is still created
// correctly and NOBODY CAN SIGN IN. That is deliberate and it is loud: the
// preflight says so at startup. An installation that cannot be signed into is
// a phone call; an installation anybody can sign into is a breach.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { TEMPLATES, EMAIL_TEMPLATE_TYPES } from '../domain/email.mjs';
import { hashPassword } from './auth/local-auth.ts';
import { ROLE_ROWS, SAMPLE_CONTEXT, toPlaceholders, seed } from './seed.ts';

export type BootstrapResult = {
  created: boolean;
  orgId: string | null;
  /** True when the database has no way for anybody to sign in. */
  noCredentials: boolean;
  notes: string[];
};

/**
 * The one entry point the server calls. Development keeps the pilot cast;
 * production gets the company's own empty system and at most one administrator.
 */
export function bootstrapDatabase(
  db: DatabaseSync,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date().toISOString(),
): BootstrapResult {
  if (env.NODE_ENV !== 'production') {
    const result = seed(db, now);
    return { created: result.seeded, orgId: result.orgId, noCredentials: false, notes: [] };
  }
  return bootstrapProduction(db, env, now);
}

function bootstrapProduction(db: DatabaseSync, env: NodeJS.ProcessEnv, now: string): BootstrapResult {
  const notes: string[] = [];

  // Roles are structure — every user_roles row has a foreign key to them — so
  // they are reconciled on every start rather than only on creation. Adding a
  // role to the product must not require a fresh database.
  for (const [key, label, description] of ROLE_ROWS) {
    db.prepare('insert or ignore into roles (key, label, description) values (?,?,?)').run(key, label, description);
  }

  const existing = db.prepare('select id from orgs limit 1').get() as any;
  if (existing) {
    // An established installation. Nothing here may touch its data: no
    // credential backfill (that is what hands out the demo password), no
    // reference rows, no settings. The only question left is whether anybody
    // can sign in, and that is worth answering out loud on every start.
    const credentials = db.prepare('select count(*) as n from auth_identities where disabled = 0').get() as any;
    return {
      created: false,
      orgId: existing.id,
      noCredentials: Number(credentials?.n ?? 0) === 0,
      notes,
    };
  }

  // THE ORGANIZATION'S IDENTITY, AND WHY IT MAY BE DECLARED.
  //
  // This was `randomUUID()` and nothing else, which was correct for a tenant
  // key and wrong for everything that has to refer to this organization from
  // OUTSIDE the database. Two consequences, neither visible until the day they
  // cost something:
  //
  //   * Measurement cannot be prepared in advance. A baseline records what a
  //     named organization's work cost before AWE (proof/baselines/), and it is
  //     bound to an org id. If that id is not knowable until after first start,
  //     no baseline can exist on the day the first real purchase happens — and
  //     that purchase is then unmeasurable for ever, because a baseline written
  //     afterwards cannot govern work that predates it.
  //
  //   * Continuity does not survive a reinstall. Restore into a fresh database,
  //     or rebuild the VM, and a new UUID is minted. Every baseline, every
  //     frozen case study and every historical claim silently stops matching
  //     the organization they were about.
  //
  // So the id may be DECLARED, and generated only when it is not. A declared id
  // is a deliberate, stable, human-readable name for the tenant — `lippolis` —
  // that the environment file carries beside the letterhead, and that a restore
  // reproduces exactly.
  //
  // Constrained to the shape an identifier can safely have in a path, a URL and
  // a filename, because it appears in all three. A generated UUID remains the
  // default, so an installation that says nothing behaves exactly as before.
  // WHAT KIND OF INSTALLATION IS THIS?
  //
  // Stamped into the database at creation, once, because the alternative is
  // that nothing can tell a rehearsal from the real thing. This is not
  // hypothetical: the deployment rehearsal for this application builds the
  // production artifact, starts it with the real company name and the real
  // organization id, and drives real purchases through it. The resulting file
  // is byte-for-byte the shape of production and contains no production
  // evidence whatsoever. Point the case-study reader at it and it will report
  // Lippolis executions that never happened.
  //
  // FAILS CLOSED. Only an explicit PCC_ENVIRONMENT=production counts as
  // production. A rehearsal that forgets to declare itself is treated as a
  // rehearsal, which is the harmless mistake; a production install that forgets
  // is refused as evidence until somebody says so out loud, which is the
  // recoverable one. There is deliberately no inference from NODE_ENV — the
  // rehearsal sets NODE_ENV=production too, because it must.
  const environment = (env.PCC_ENVIRONMENT ?? '').trim().toLowerCase() || 'unstamped';
  if (!['production', 'rehearsal', 'development', 'unstamped'].includes(environment)) {
    throw new Error(
      `PCC_ENVIRONMENT must be production, rehearsal or development. Got ${JSON.stringify(environment)}.`);
  }
  db.prepare(
    `insert into schema_meta (key, value) values ('environment', ?)
       on conflict(key) do nothing`,
  ).run(environment);
  if (environment !== 'production') {
    notes.push(`environment "${environment}" — this database is NOT production and its records are not evidence`);
  }

  const declaredOrgId = (env.PCC_ORG_ID ?? '').trim();
  if (declaredOrgId && !/^[a-z][a-z0-9_-]{1,62}$/.test(declaredOrgId)) {
    throw new Error(
      `PCC_ORG_ID must be lowercase letters, digits, hyphen or underscore, starting with a letter ` +
      `(2-63 characters). Got: ${JSON.stringify(declaredOrgId)}. It is the tenant's permanent ` +
      `identity — it appears in evidence, baselines and backups — so it is validated rather than ` +
      `accepted and regretted.`);
  }
  const orgId = declaredOrgId || randomUUID();
  if (declaredOrgId) {
    notes.push(`organization id declared as "${declaredOrgId}" — measurement and baselines can be prepared against it, and a restore reproduces it`);
  }
  const orgName = (env.PCC_ORG_NAME ?? '').trim() || 'Lippolis Electric, Inc.';

  // THE LETTERHEAD IS NOT OPTIONAL, AND THIS IS THE ONLY MOMENT IT CAN BE SET.
  //
  // The address and the telephone number print on every purchase order that
  // reaches a supplier. They are read HERE and nowhere else — once this row
  // exists no screen edits it — so a first start without them produces a
  // company whose paperwork carries no address and no telephone number for as
  // long as the installation lives, fixable only by editing the row on the
  // server. Verified by starting production without them: PCC came up, logged
  // ready, reported healthy, and wrote nulls.
  //
  // Refused BEFORE the transaction that creates the organization, so nothing
  // supplier-facing can be generated from a half-identified company. The
  // database file already exists at this point — it is schema, and only schema.
  // Setting the two variables and starting again creates the organization
  // correctly, so the state this leaves behind is a database waiting for its
  // first start, not a broken one.
  const orgAddress = (env.PCC_ORG_ADDRESS ?? '').trim();
  const orgPhone = (env.PCC_ORG_PHONE ?? '').trim();
  const missing = [
    orgAddress ? null : 'PCC_ORG_ADDRESS',
    orgPhone ? null : 'PCC_ORG_PHONE',
  ].filter(Boolean);
  if (missing.length) {
    // Tagged so the startup summary can say CONFIGURATION rather than send an
    // operator to check filesystem permissions and the schema, which are fine.
    throw Object.assign(new Error(
      `${missing.join(' and ')} must be set before the first start — ` +
        'the company address and telephone number print on every purchase order sent to a supplier, ' +
        'they can only be set when the organization is created, and no screen edits them afterwards. ' +
        'Nothing has been created: set them and start again. ' +
        'Lippolis: PCC_ORG_ADDRESS="Licensed Electrical Contractor · 25 Seventh Street, Pelham, NY 10803", ' +
        'PCC_ORG_PHONE="(914) 738-3550".',
    ), { pccReason: 'configuration' as const });
  }

  db.exec('begin immediate');
  try {
    db.prepare('insert into orgs (id, name, phone, address, created_at, updated_at) values (?,?,?,?,?,?)').run(
      orgId,
      orgName,
      orgPhone,
      orgAddress,
      now,
      now,
    );

    // The two destinations that are not job sites. WORKSHOP especially: it is
    // a first-class delivery destination and receiving authority is granted by
    // assignment to it, so a database without one cannot express "it came to
    // the shop" at all. Job sites are the company's and are entered in Admin.
    for (const location of [
      { name: 'Workshop', kind: 'WORKSHOP' },
      { name: 'Office', kind: 'OFFICE' },
      { name: 'Vendor counter pickup', kind: 'VENDOR_PICKUP' },
    ]) {
      db.prepare(
        'insert into delivery_locations (id, org_id, name, address, kind, is_active, created_at, updated_at) values (?,?,?,?,?,1,?,?)',
      ).run(randomUUID(), orgId, location.name, null, location.kind, now, now);
    }

    // NO PURCHASE ORDER SEQUENCE IS CREATED, because there is no such thing as
    // one. A number is job + vendor + sequence, and each (job, vendor) pair
    // counts on its own from 1 — the counters come into existence as orders are
    // raised. A fresh installation therefore has nothing to correct and no
    // placeholder to send a supplier by accident.
    //
    // What DOES still need a person: any pair the office has already written
    // paper purchase orders for. That is declared per pair in Administration ->
    // PO numbering, and only where it is true.
    notes.push(
      'Purchase orders are numbered job-vendor-sequence, e.g. 1234-COOPER-1, counting from 1 for each ' +
        'job and vendor. Where the office has already issued paper purchase orders for a job and vendor ' +
        'PCC will now be used for, set that pair in Administration before the first order.',
    );

    db.prepare(
      'insert into request_number_sequences (org_id, prefix, padding, suffix, next_value, updated_at) values (?,?,?,?,?,?)',
    ).run(orgId, 'PR-', 5, '', 1001, now);

    db.prepare(
      `insert into system_settings (org_id, allow_self_approval, external_send_enabled, require_email_review,
                                    overdue_grace_hours, default_delivery_method, po_template_key, updated_at)
       values (?,0,0,1,0,'DELIVERY','lippolis_default',?)`,
    ).run(orgId, now);

    for (const key of EMAIL_TEMPLATE_TYPES) {
      const sample = (TEMPLATES as any)[key](SAMPLE_CONTEXT);
      db.prepare(
        'insert into email_templates (id, org_id, template_key, subject, body, is_active, updated_at) values (?,?,?,?,?,1,?)',
      ).run(randomUUID(), orgId, key, toPlaceholders(sample.subject), toPlaceholders(sample.body), now);
    }

    db.exec('commit');
  } catch (err) {
    db.exec('rollback');
    throw err;
  }

  const admin = createBootstrapAdministrator(db, env, orgId, now);
  notes.push(...admin.notes);

  return { created: true, orgId, noCredentials: !admin.created, notes };
}

/**
 * The one account that exists so somebody can sign in and invite the others.
 *
 * Created only on a database with no users, only from configuration, and only
 * when the password is long enough to be worth having. A short one would be
 * the published-password problem again wearing a different hat.
 */
function createBootstrapAdministrator(
  db: DatabaseSync, env: NodeJS.ProcessEnv, orgId: string, now: string,
): { created: boolean; notes: string[] } {
  const email = (env.PCC_BOOTSTRAP_ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = env.PCC_BOOTSTRAP_ADMIN_PASSWORD ?? '';
  const name = (env.PCC_BOOTSTRAP_ADMIN_NAME ?? '').trim() || 'Administrator';

  if (!email && !password) {
    return {
      created: false,
      notes: [
        'no PCC_BOOTSTRAP_ADMIN_EMAIL / PCC_BOOTSTRAP_ADMIN_PASSWORD was set, so NOBODY CAN SIGN IN. ' +
          'Set both, restart once, then remove the password from the environment.',
      ],
    };
  }
  if (!email || !password) {
    return {
      created: false,
      notes: ['PCC_BOOTSTRAP_ADMIN_EMAIL and PCC_BOOTSTRAP_ADMIN_PASSWORD must both be set; no administrator was created'],
    };
  }
  if (password.length < 12) {
    return {
      created: false,
      notes: ['PCC_BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters; no administrator was created'],
    };
  }

  const users = db.prepare('select count(*) as n from users').get() as any;
  if (Number(users?.n ?? 0) > 0) {
    return { created: false, notes: ['users already exist; the bootstrap administrator was not created'] };
  }

  const id = randomUUID();
  db.exec('begin immediate');
  try {
    db.prepare(
      `insert into users (id, org_id, full_name, email, is_active, can_approve, is_primary_approver,
                          is_backup_approver, is_delivery_receiver, created_at, updated_at)
       values (?,?,?,?,1,1,0,0,0,?,?)`,
    ).run(id, orgId, name, email, now, now);
    db.prepare('insert into user_roles (user_id, role_key, granted_at) values (?,?,?)').run(id, 'ADMIN', now);
    const { hash, salt } = hashPassword(password);
    // must_change_password = 1. THE BOOTSTRAP PASSWORD IS THE MOST EXPOSED
    // CREDENTIAL THIS APPLICATION EVER HAS: it is typed into a file on disk,
    // read by whoever installs, and the instructions then tell them to delete
    // it. "Change this password" was already the first line of the install
    // checklist; this makes it the first thing the account can do, and the only
    // thing it can do until it is done.
    db.prepare(
      `insert into auth_identities
         (user_id, email, password_hash, salt, disabled, must_change_password, created_at, updated_at)
       values (?,?,?,?,0,1,?,?)`,
    ).run(id, email, hash, salt, now, now);
    db.exec('commit');
  } catch (err) {
    db.exec('rollback');
    throw err;
  }

  return {
    created: true,
    notes: [
      `created the bootstrap administrator ${email}. Signing in will ask for a new password before ` +
        'anything else; then invite the real users and remove PCC_BOOTSTRAP_ADMIN_PASSWORD from the environment.',
    ],
  };
}

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

  const orgId = randomUUID();
  const orgName = (env.PCC_ORG_NAME ?? '').trim() || 'Lippolis Electric, Inc.';

  db.exec('begin immediate');
  try {
    db.prepare('insert into orgs (id, name, phone, address, created_at, updated_at) values (?,?,?,?,?,?)').run(
      orgId,
      orgName,
      (env.PCC_ORG_PHONE ?? '').trim() || null,
      (env.PCC_ORG_ADDRESS ?? '').trim() || null,
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

/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// seed.ts — the pilot's starting data: one org, the real cast of roles, and
// enough reference data to run the §16 demo scenario end to end.
//
// People: Mike is the primary workshop approver, Rick the authorized backup —
// both hold WORKSHOP_APPROVER, and the primary/backup flags decide who the
// queue nags first, not who is allowed to act. Names beyond Mike and Rick are
// placeholders; vendors, contacts, jobs and addresses are INVENTED and every
// email address is @example.invalid so a misconfigured mail client has nowhere
// to deliver.
//
// Idempotent: seeding an already-seeded database is a no-op.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { TEMPLATES, EMAIL_TEMPLATE_TYPES } from '../domain/email.mjs';
import { hashPassword } from './auth/local-auth.ts';
import { assignVendorCode } from '../domain/po-number.mjs';

export const DEMO_ORG_ID = '11111111-1111-4111-8111-111111111111';

/**
 * The pilot cast. `password` seeds the local credential provider — these are
 * DEMO accounts on a closed pilot, documented in the README, and the seeding
 * only ever happens on a database that has none. A real deployment invites
 * users through Admin and sets a password per person.
 */
export const DEMO_PASSWORD = 'Purchasing!2026';

export const DEMO_USERS = [
  { key: 'mike', name: 'Mike (workshop)', email: 'mike@example.invalid', roles: ['WORKSHOP_APPROVER'], primary: true, backup: false, canApprove: true, jobs: [] },
  { key: 'rick', name: 'Rick (workshop backup)', email: 'rick@example.invalid', roles: ['WORKSHOP_APPROVER'], primary: false, backup: true, canApprove: true, jobs: [] },
  // A foreman: raises requests AND signs for what lands on his sites.
  { key: 'foreman', name: 'Dave Kearns (foreman)', email: 'dave@example.invalid', roles: ['FOREMAN'], primary: false, backup: false, canApprove: false, receiver: true, jobs: ['24-118', '25-007'] },
  // A second foreman, assigned to a DIFFERENT job — so "a foreman can access
  // only assigned job-site deliveries" is demonstrable rather than asserted.
  { key: 'foreman2', name: 'Luis Ferrara (foreman)', email: 'luis@example.invalid', roles: ['FOREMAN'], primary: false, backup: false, canApprove: false, receiver: true, jobs: ['24-203'] },
  { key: 'apprentice', name: 'Sam Ortiz (field)', email: 'sam@example.invalid', roles: ['REQUESTOR'], primary: false, backup: false, canApprove: false, jobs: [] },
  { key: 'office', name: 'Karen Doyle (office)', email: 'karen@example.invalid', roles: ['OFFICE'], primary: false, backup: false, canApprove: false, jobs: [] },
  // Deliberate: an office user WITH the approval grant, so "office cannot
  // approve unless separately granted" is demonstrable in both directions.
  { key: 'office_approver', name: 'Tom Reilly (office, approval granted)', email: 'tom@example.invalid', roles: ['OFFICE'], primary: false, backup: false, canApprove: true, jobs: [] },
  { key: 'accounting', name: 'Ann Petrillo (accounting)', email: 'ann@example.invalid', roles: ['ACCOUNTING'], primary: false, backup: false, canApprove: false, jobs: [] },
  { key: 'admin', name: 'System Administrator', email: 'admin@example.invalid', roles: ['ADMIN'], primary: false, backup: false, canApprove: true, jobs: [] },
  // A disabled account, so the "a disabled user cannot sign in" gate has
  // something real to fail against.
  { key: 'disabled', name: 'Former Employee', email: 'former@example.invalid', roles: ['REQUESTOR'], primary: false, backup: false, canApprove: false, jobs: [], disabled: true },
];

export const ROLE_ROWS = [
  ['REQUESTOR', 'Requestor', 'Field workers and anyone raising a material request.'],
  ['FOREMAN', 'Foreman', 'Raises requests and signs for deliveries on assigned job sites.'],
  ['ACCOUNTING', 'Accounting', 'Reads receipt evidence and produces the AP packet. No purchasing authority.'],
  ['OFFICE', 'Office', 'Office staff: full visibility, no purchasing authority unless granted.'],
  ['WORKSHOP_APPROVER', 'Workshop approver', 'Records stock, chooses vendor and cost, approves, generates POs, receives.'],
  ['ADMIN', 'Administrator', 'Users, roles, vendors, templates, PO numbering, settings, audit.'],
];

const VENDORS = [
  { name: 'Graybar Electric', account: 'LE-4471', phone: '(914) 555-0142', address: '210 Commerce Way, Elmsford NY', contact: { name: 'Angela Ruiz', email: 'orders.graybar@example.invalid', phone: '(914) 555-0143' } },
  { name: 'Rexel / Capitol Light', account: 'LE-2290', phone: '(203) 555-0177', address: '88 Industrial Park Rd, Stamford CT', contact: { name: 'Dennis Fahey', email: 'orders.rexel@example.invalid', phone: '(203) 555-0178' } },
  { name: 'City Electric Supply', account: 'LE-8815', phone: '(914) 555-0119', address: '5 Warehouse Ln, Yonkers NY', contact: { name: 'Priya Nair', email: 'orders.ces@example.invalid', phone: '(914) 555-0120' } },
];

const LOCATIONS = [
  { name: 'Workshop — Main Shop', kind: 'WORKSHOP', address: '14 Depot St, Port Chester NY' },
  { name: 'Office', kind: 'OFFICE', address: '14 Depot St, Port Chester NY' },
  { name: 'Job site — 1180 Anderson Ave', kind: 'JOBSITE', address: '1180 Anderson Ave, White Plains NY' },
  { name: 'Job site — Harrison HS Gym', kind: 'JOBSITE', address: '255 Union Ave, Harrison NY' },
  { name: 'Vendor counter pickup', kind: 'VENDOR_PICKUP', address: 'Vendor branch' },
];

const JOBS = [
  { number: '24-118', name: 'Anderson Ave tenant fit-out', address: '1180 Anderson Ave, White Plains NY' },
  { number: '24-203', name: 'Harrison HS gym lighting', address: '255 Union Ave, Harrison NY' },
  { number: '25-007', name: 'Service upgrade — Depot St', address: '14 Depot St, Port Chester NY' },
];

export function seed(db: DatabaseSync, now = new Date().toISOString()) {
  const existing = db.prepare('select id from orgs where id = ?').get(DEMO_ORG_ID) as any;
  if (existing) {
    // An already-seeded pilot database predates the credential store: its users
    // exist but have no way to sign in. Give each one the documented demo
    // password rather than stranding a running pilot behind a login form.
    backfillPilotCredentials(db, now);
    return { seeded: false, orgId: DEMO_ORG_ID };
  }

  db.exec('begin immediate');
  try {
    db.prepare('insert into orgs (id, name, phone, address, created_at, updated_at) values (?,?,?,?,?,?)').run(
      DEMO_ORG_ID,
      'Lippolis Electric, Inc.',
      '(914) 555-0100',
      '14 Depot Street, Port Chester, NY 10573',
      now,
      now,
    );

    for (const [key, label, description] of ROLE_ROWS) {
      db.prepare('insert or ignore into roles (key, label, description) values (?,?,?)').run(key, label, description);
    }

    for (const u of DEMO_USERS) {
      const id = randomUUID();
      const disabled = 'disabled' in u && u.disabled === true;
      db.prepare(
        `insert into users (id, org_id, full_name, email, is_active, can_approve, is_primary_approver,
                            is_backup_approver, is_delivery_receiver, created_at, updated_at)
         values (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, DEMO_ORG_ID, u.name, u.email, disabled ? 0 : 1, u.canApprove ? 1 : 0,
        u.primary ? 1 : 0, u.backup ? 1 : 0, 'receiver' in u && u.receiver ? 1 : 0, now, now,
      );
      for (const role of u.roles) {
        db.prepare('insert into user_roles (user_id, role_key, granted_at) values (?,?,?)').run(id, role, now);
      }
      for (const jobNumber of u.jobs ?? []) {
        db.prepare('insert into user_job_assignments (user_id, job_number, assigned_at) values (?,?,?)')
          .run(id, jobNumber, now);
      }
      // Credentials go to the auth provider's table, never to a purchasing one.
      const { hash, salt } = hashPassword(DEMO_PASSWORD);
      db.prepare(
        `insert into auth_identities (user_id, email, password_hash, salt, disabled, created_at, updated_at)
         values (?,?,?,?,?,?,?)`,
      ).run(id, u.email, hash, salt, disabled ? 1 : 0, now, now);
    }

    const vendorCodes: string[] = [];
    for (const v of VENDORS) {
      const vendorId = randomUUID();
      // The code the vendor is known by inside a purchase order number. Derived
      // by the same domain function the application uses, so the fixture cannot
      // demonstrate a numbering scheme the product does not have.
      const code = assignVendorCode(v.name, vendorCodes);
      vendorCodes.push(code);
      db.prepare(
        'insert into vendors (id, org_id, name, code, account_number, phone, address, is_active, created_at, updated_at) values (?,?,?,?,?,?,?,1,?,?)',
      ).run(vendorId, DEMO_ORG_ID, v.name, code, v.account, v.phone, v.address, now, now);
      db.prepare(
        'insert into vendor_contacts (id, vendor_id, name, email, phone, is_primary, created_at, updated_at) values (?,?,?,?,?,1,?,?)',
      ).run(randomUUID(), vendorId, v.contact.name, v.contact.email, v.contact.phone, now, now);
    }

    for (const l of LOCATIONS) {
      db.prepare(
        'insert into delivery_locations (id, org_id, name, address, kind, is_active, created_at, updated_at) values (?,?,?,?,?,1,?,?)',
      ).run(randomUUID(), DEMO_ORG_ID, l.name, l.address, l.kind, now, now);
    }

    for (const j of JOBS) {
      db.prepare('insert into jobs (id, org_id, job_number, name, address, is_active, created_at) values (?,?,?,?,?,1,?)').run(
        randomUUID(), DEMO_ORG_ID, j.number, j.name, j.address, now,
      );
    }

    // NO PURCHASE ORDER SEQUENCE IS SEEDED, and there is nothing to seed.
    //
    // A purchase order number is job + vendor + sequence, and every (job,
    // vendor) pair starts at 1 because a pair PCC has issued nothing for HAS
    // issued nothing. The counters create themselves, one row at a time, as
    // orders are raised. Where the office already wrote paper purchase orders
    // for a pair, an administrator declares that pair explicitly in
    // Administration -> PO numbering; that is a statement about the real world
    // and a fixture must not fabricate one.
    //
    // This replaces a seeded global counter (LE-52901) that existed only
    // because the old model needed a starting number nobody had supplied.

    db.prepare(
      'insert into request_number_sequences (org_id, prefix, padding, suffix, next_value, updated_at) values (?,?,?,?,?,?)',
    ).run(DEMO_ORG_ID, 'PR-', 5, '', 1001, now);

    db.prepare(
      `insert into system_settings (org_id, allow_self_approval, external_send_enabled, require_email_review,
                                    overdue_grace_hours, default_delivery_method, po_template_key,
                                    default_fulfilment_days, default_need_by_time, updated_at)
       values (?,0,0,1,0,'DELIVERY','awe_default',1,'07:00',?)`,
    ).run(DEMO_ORG_ID, now);

    // Templates start as the built-in defaults, materialized as editable rows
    // so Admin -> Email Templates has something to edit on day one.
    for (const key of EMAIL_TEMPLATE_TYPES) {
      const sample = (TEMPLATES as any)[key](SAMPLE_CONTEXT);
      db.prepare(
        'insert into email_templates (id, org_id, template_key, subject, body, is_active, updated_at) values (?,?,?,?,?,1,?)',
      ).run(randomUUID(), DEMO_ORG_ID, key, toPlaceholders(sample.subject), toPlaceholders(sample.body), now);
    }

    db.exec('commit');
  } catch (err) {
    db.exec('rollback');
    throw err;
  }
  return { seeded: true, orgId: DEMO_ORG_ID };
}

/**
 * Give every user without one a credential row, and every seeded foreman their
 * job assignments. Runs only on a database that already has an organization —
 * a fresh one gets both from the seed itself.
 *
 * This is a PILOT convenience with a documented password, not a production
 * path: an installation that has invited its own users never reaches it,
 * because those users already have identities.
 */
function backfillPilotCredentials(db: DatabaseSync, now: string) {
  // Reference rows first: FOREMAN and ACCOUNTING did not exist when an older
  // pilot database was created, and user_roles has a foreign key to roles.
  for (const [key, label, description] of ROLE_ROWS) {
    db.prepare('insert or ignore into roles (key, label, description) values (?,?,?)').run(key, label, description);
  }

  const users = db.prepare('select id, email, is_active from users').all() as any[];
  for (const user of users) {
    const identity = db.prepare('select user_id from auth_identities where user_id = ?').get(user.id) as any;
    if (identity) continue;
    const { hash, salt } = hashPassword(DEMO_PASSWORD);
    db.prepare(
      `insert into auth_identities (user_id, email, password_hash, salt, disabled, created_at, updated_at)
       values (?,?,?,?,?,?,?)`,
    ).run(user.id, user.email, hash, salt, user.is_active ? 0 : 1, now, now);
  }

  // Reconcile the SEEDED cast with what the pilot now models: roles that did
  // not exist when the database was created (FOREMAN, ACCOUNTING), the delivery
  // receiver designation, and job assignments. Matched by the seeded email
  // address only — a user an administrator invited is never touched here.
  for (const u of DEMO_USERS) {
    let row = db.prepare('select id from users where lower(email) = lower(?)').get(u.email) as any;

    // Cast members added after this database was created (accounting, the
    // second foreman, the disabled account) are created rather than skipped —
    // otherwise an upgraded pilot is missing the people the walkthrough uses.
    if (!row) {
      const id = randomUUID();
      const disabled = 'disabled' in u && u.disabled === true;
      db.prepare(
        `insert into users (id, org_id, full_name, email, is_active, can_approve, is_primary_approver,
                            is_backup_approver, is_delivery_receiver, created_at, updated_at)
         values (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(id, DEMO_ORG_ID, u.name, u.email, disabled ? 0 : 1, u.canApprove ? 1 : 0,
            u.primary ? 1 : 0, u.backup ? 1 : 0, 'receiver' in u && u.receiver ? 1 : 0, now, now);
      const { hash, salt } = hashPassword(DEMO_PASSWORD);
      db.prepare(
        `insert into auth_identities (user_id, email, password_hash, salt, disabled, created_at, updated_at)
         values (?,?,?,?,?,?,?)`,
      ).run(id, u.email, hash, salt, disabled ? 1 : 0, now, now);
      row = { id };
    }

    const current = (db.prepare('select role_key from user_roles where user_id = ?').all(row.id) as any[])
      .map((r) => r.role_key as string);
    if (current.sort().join(',') !== [...u.roles].sort().join(',')) {
      db.prepare('delete from user_roles where user_id = ?').run(row.id);
      for (const role of u.roles) {
        db.prepare('insert into user_roles (user_id, role_key, granted_at) values (?,?,?)').run(row.id, role, now);
      }
    }

    db.prepare('update users set is_delivery_receiver = ? where id = ?')
      .run('receiver' in u && u.receiver ? 1 : 0, row.id);

    for (const jobNumber of u.jobs ?? []) {
      db.prepare('insert or ignore into user_job_assignments (user_id, job_number, assigned_at) values (?,?,?)')
        .run(row.id, jobNumber, now);
    }
  }

}

/**
 * The built-in templates are functions; the editable rows are text with
 * {{placeholders}}. Rendering a known sample and substituting the sample values
 * back out keeps the two in sync without maintaining the wording twice.
 */
export const SAMPLE_CONTEXT: any = {
  org: { name: '@@org.name@@', phone: '@@org.phone@@' },
  request: {
    requestNumber: '@@request.requestNumber@@', jobNumber: '@@request.jobNumber@@',
    requestorName: '@@request.requestorName@@', needByDate: '@@request.needByDate@@',
    needByTime: '@@request.needByTime@@', deliveryLocationName: '@@request.deliveryLocationName@@',
    deliveryAddress: '@@request.deliveryAddress@@', deliveryMethod: 'DELIVERY', reason: '@@request.reason@@',
  },
  purchaseOrder: {
    poNumber: '@@purchaseOrder.poNumber@@',
    estimatedTotalCents: '@@purchaseOrder.estimatedTotal@@',
    orderedAt: '@@purchaseOrder.orderedAt@@',
  },
  vendorContact: { name: '@@vendorContact.name@@' },
  approverName: '@@approverName@@',
  sender: { name: '@@sender.name@@' },
  question: '@@question@@',
  reason: '@@reason@@',
  shortNote: '@@shortNote@@',
  items: '@@itemsTable@@',
  links: { review: '@@links.review@@' },
};

export function toPlaceholders(text: string): string {
  return String(text).replace(/@@([\w.]+)@@/g, '{{$1}}');
}

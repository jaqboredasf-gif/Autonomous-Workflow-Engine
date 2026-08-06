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
import { DEFAULT_PO_CONFIG } from '../domain/po-number.mjs';

export const DEMO_ORG_ID = '11111111-1111-4111-8111-111111111111';

export const DEMO_USERS = [
  { key: 'mike', name: 'Mike (workshop)', email: 'mike@example.invalid', roles: ['WORKSHOP_APPROVER'], primary: true, backup: false, canApprove: true },
  { key: 'rick', name: 'Rick (workshop backup)', email: 'rick@example.invalid', roles: ['WORKSHOP_APPROVER'], primary: false, backup: true, canApprove: true },
  { key: 'foreman', name: 'Dave Kearns (foreman)', email: 'dave@example.invalid', roles: ['REQUESTOR'], primary: false, backup: false, canApprove: false },
  { key: 'apprentice', name: 'Sam Ortiz (field)', email: 'sam@example.invalid', roles: ['REQUESTOR'], primary: false, backup: false, canApprove: false },
  { key: 'office', name: 'Karen Doyle (office)', email: 'karen@example.invalid', roles: ['OFFICE'], primary: false, backup: false, canApprove: false },
  // Deliberate: an office user WITH the approval grant, so "office cannot
  // approve unless separately granted" is demonstrable in both directions.
  { key: 'office_approver', name: 'Tom Reilly (office, approval granted)', email: 'tom@example.invalid', roles: ['OFFICE'], primary: false, backup: false, canApprove: true },
  { key: 'admin', name: 'System Administrator', email: 'admin@example.invalid', roles: ['ADMIN'], primary: false, backup: false, canApprove: true },
];

const ROLE_ROWS = [
  ['REQUESTOR', 'Requestor', 'Foremen, field workers and anyone raising a material request.'],
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
  if (existing) return { seeded: false, orgId: DEMO_ORG_ID };

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
      db.prepare(
        `insert into users (id, org_id, full_name, email, is_active, can_approve, is_primary_approver,
                            is_backup_approver, created_at, updated_at)
         values (?,?,?,?,1,?,?,?,?,?)`,
      ).run(id, DEMO_ORG_ID, u.name, u.email, u.canApprove ? 1 : 0, u.primary ? 1 : 0, u.backup ? 1 : 0, now, now);
      for (const role of u.roles) {
        db.prepare('insert into user_roles (user_id, role_key, granted_at) values (?,?,?)').run(id, role, now);
      }
    }

    for (const v of VENDORS) {
      const vendorId = randomUUID();
      db.prepare(
        'insert into vendors (id, org_id, name, account_number, phone, address, is_active, created_at, updated_at) values (?,?,?,?,?,?,1,?,?)',
      ).run(vendorId, DEMO_ORG_ID, v.name, v.account, v.phone, v.address, now, now);
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

    db.prepare(
      'insert into po_number_sequences (org_id, prefix, padding, suffix, next_value, updated_at) values (?,?,?,?,?,?)',
    ).run(DEMO_ORG_ID, DEFAULT_PO_CONFIG.prefix, DEFAULT_PO_CONFIG.padding, DEFAULT_PO_CONFIG.suffix, DEFAULT_PO_CONFIG.nextNumber, now);

    db.prepare(
      'insert into request_number_sequences (org_id, prefix, padding, suffix, next_value, updated_at) values (?,?,?,?,?,?)',
    ).run(DEMO_ORG_ID, 'PR-', 5, '', 1001, now);

    db.prepare(
      `insert into system_settings (org_id, allow_self_approval, external_send_enabled, require_email_review,
                                    overdue_grace_hours, default_delivery_method, po_template_key, updated_at)
       values (?,0,0,1,0,'DELIVERY','lippolis_default',?)`,
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
 * The built-in templates are functions; the editable rows are text with
 * {{placeholders}}. Rendering a known sample and substituting the sample values
 * back out keeps the two in sync without maintaining the wording twice.
 */
const SAMPLE_CONTEXT: any = {
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

function toPlaceholders(text: string): string {
  return String(text).replace(/@@([\w.]+)@@/g, '{{$1}}');
}

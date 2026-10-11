// ---------------------------------------------------------------------------
// profiles/org-002-authorization.mjs — a second organization's role vocabulary.
//
// A synthetic mechanical contractor with a different org chart. It is an
// ARCHITECTURAL TEST FIXTURE, not a customer: its only job is to answer whether
// purchasing still works when the role names it was built around are absent.
//
// The differences that matter:
//   · no WORKSHOP_APPROVER, and no workshop — OPERATIONS_MANAGER approves
//   · no separate ACCOUNTING role; the office does that work
//   · a YARD_HAND who may receive but nothing else
//   · no per-person approval grant at all: this organization decides authority
//     by role and does not want individual exceptions
//
// Every capability below comes from the domain's canonical vocabulary. The
// profile chooses the SHAPE of the organization; it cannot invent what
// purchasing can do.
// ---------------------------------------------------------------------------

import { defineAuthorizationProfile } from '../authorization.mjs';

export const org002Authorization = defineAuthorizationProfile({
  orgId: 'org-002-trades',

  roles: {
    // Anybody on a site can ask for material.
    FIELD_STAFF: [
      'request.create',
      'request.read.own',
      'request.update.own',
      'request.cancel.own',
      'request.submit',
      'request.respond_clarification',
      'request.attach',
    ],

    // The role that replaces WORKSHOP_APPROVER. Same work, different name, and
    // purchasing has no way to tell the difference.
    OPERATIONS_MANAGER: [
      'request.read.all',
      'review.read_queue',
      'review.record_stock',
      'review.set_quantities',
      'review.set_vendor',
      'review.set_cost',
      'review.decide',
      'po.generate',
      'email.draft',
      'email.review',
      'order.mark_ordered',
      'order.track',
      'receiving.record',
      'request.complete',
      'request.cancel.any',
    ],

    // Office staff here do the accounting work too — no separate role.
    OFFICE_ADMIN: [
      'request.read.all',
      'accounting.read',
      'accounting.packet',
      'order.track',
      'receiving.record',
      'request.note',
    ],

    // Receives deliveries and does nothing else. Deliberately narrow, to prove
    // a capability nobody holds is genuinely refused.
    YARD_HAND: [
      'request.read.all',
      'receiving.record',
    ],

    SYSTEM_ADMIN: [
      'admin.users',
      'admin.invite',
      'admin.assignments',
      'admin.vendors',
      'admin.locations',
      'admin.settings',
      'admin.po_config',
      'admin.audit',
      'request.read.all',
    ],
  },

  // This organization grants authority by role only.
  approvalGrant: [],
});

export default org002Authorization;

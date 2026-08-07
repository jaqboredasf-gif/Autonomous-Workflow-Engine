// ---------------------------------------------------------------------------
// roles.mjs — roles, permissions, and the authorization decisions.
//
// PURE. Same contract as status.mjs: no I/O, no clock, no globals.
//
// The permission table here is the ONE definition of who may do what. The
// server (src/server/service.ts) calls `authorize()` before every mutation, so
// hiding a button is a courtesy, never the control. The Supabase path
// (0016_purchasing_control.sql) re-states the same rules as RLS policies and
// security-definer RPC guards; validate-migration-0016.mjs asserts the role and
// permission vocabularies match.
//
// Roles are additive: a user holds one or more. `canApprove` is a separate
// GRANT on top of the role, because the spec requires "office users cannot
// approve unless separately granted approval authority" — a grant, not a role.
// ---------------------------------------------------------------------------

export const ROLES = ['REQUESTOR', 'FOREMAN', 'OFFICE', 'ACCOUNTING', 'WORKSHOP_APPROVER', 'ADMIN'];

/**
 * Every distinguishable action in the system. One string per thing a human can
 * do; the UI asks with these names and the server checks with these names.
 */
export const PERMISSIONS = [
  // Requesting
  'request.create',
  'request.read.own',
  'request.read.all',
  'request.update.own',
  'request.submit',
  'request.cancel.own',
  'request.respond_clarification',
  'request.attach',
  'request.note',
  // Workshop review + purchasing decisions
  'review.read_queue',
  'review.record_stock',
  'review.set_quantities',
  'review.set_vendor',
  'review.set_cost',
  'review.decide',
  // Downstream processing
  'po.generate',
  'email.draft',
  'email.review',
  'order.mark_ordered',
  'order.track',
  'receiving.record',
  'inventory.adjust',
  'request.complete',
  'request.cancel.any',
  // Job-site delivery confirmation (a foreman signing for what arrived)
  'deliveries.confirm',
  // Accounting: read-only evidence, and the packet it hands to AP
  'accounting.read',
  'accounting.packet',
  // Administration
  'admin.users',
  'admin.invite',
  'admin.assignments',
  'admin.vendors',
  'admin.templates',
  'admin.po_config',
  'admin.locations',
  'admin.settings',
  'admin.audit',
];

const REQUESTOR_PERMISSIONS = [
  'request.create',
  'request.read.own',
  'request.update.own',
  'request.submit',
  'request.cancel.own',
  'request.respond_clarification',
  'request.attach',
  'request.note',
];

const OFFICE_PERMISSIONS = [
  ...REQUESTOR_PERMISSIONS,
  'request.read.all',
  'request.attach',
  'request.note',
  'order.track',
  // Office may be asked to sign for a delivery; recording what physically
  // arrived is clerical, not a purchasing decision.
  'receiving.record',
];

const WORKSHOP_APPROVER_PERMISSIONS = [
  ...OFFICE_PERMISSIONS,
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
  'inventory.adjust',
  'request.complete',
  'request.cancel.any',
];

/**
 * A foreman is a requestor who also signs for deliveries — but only on the job
 * sites they are assigned to. The permission opens the workspace; the
 * assignment decides which requests inside it (see authorize() below).
 *
 * No `order.track`: a foreman reads a shipment's tracking on the request page
 * like everyone else, but entering a carrier and tracking number is the
 * purchaser's clerical act, not the field's.
 */
const FOREMAN_PERMISSIONS = [...REQUESTOR_PERMISSIONS, 'deliveries.confirm', 'receiving.record'];

/**
 * Accounting reads: it needs the evidence behind a receipt to pay an invoice,
 * and it must not be able to change a purchasing decision. No write permission
 * appears in this list on purpose.
 */
const ACCOUNTING_PERMISSIONS = [
  'request.read.own',
  'request.read.all',
  'request.note',
  // `order.track` is deliberately ABSENT. It reads like a view permission and
  // is not one: the only thing that checks it is updateTracking(), which WRITES
  // a carrier and tracking number. Accounting sees tracking through the ordinary
  // read paths, which are scoped by organization, and must not be able to alter
  // a shipment record it is supposed to be auditing.
  'accounting.read',
  'accounting.packet',
];

const ADMIN_PERMISSIONS = [...PERMISSIONS];

// ---------------------------------------------------------------------------
// THE CAPABILITY VOCABULARY — the names an operator, a contract, or another
// system uses, mapped onto the permissions this code enforces.
//
// Why both exist: the internal names are fine-grained because enforcement needs
// to be (there is a real difference between reading your own request and
// reading everyone's). The capability names are coarse because a person
// configuring roles thinks in jobs-to-be-done, not in predicates.
//
// This is a MAP, not a second system. Every capability resolves to permissions
// that authorize() already checks. Nothing is enforced against a capability
// name directly, so the two cannot drift into disagreeing.
// ---------------------------------------------------------------------------

export const CAPABILITIES = {
  'purchase.request.create': ['request.create', 'request.submit'],
  'purchase.request.view': ['request.read.own'],
  'purchase.request.view.all': ['request.read.all'],
  'purchase.request.edit': ['request.update.own'],
  'purchase.request.approve': ['review.decide'],
  'purchase.order.create': ['po.generate'],
  'purchase.order.manage': ['order.track', 'email.draft', 'email.review'],
  'purchase.order.mark_ordered': ['order.mark_ordered'],
  'receiving.confirm': ['receiving.record'],
  'vendor.manage': ['admin.vendors'],
  'job.manage': ['admin.assignments'],
  'user.manage': ['admin.users', 'admin.invite'],
  'accounting.view': ['accounting.read'],
  'audit.view': ['admin.audit'],
};

/** Does this user hold a capability? True only if they hold ALL of its permissions. */
export function hasCapability(user, capability) {
  const required = CAPABILITIES[capability];
  if (!required) return false;
  const held = new Set(permissionsFor(user));
  return required.every((p) => held.has(p));
}

/** Every capability a user holds. What an admin screen should display. */
export function capabilitiesFor(user) {
  return Object.keys(CAPABILITIES).filter((c) => hasCapability(user, c));
}

// ---------------------------------------------------------------------------
// ROLE PRESETS — the names on the admin screen.
//
// A preset is a starting point an administrator picks, not a new authorization
// primitive: it expands to roles and grants that already exist. An
// administrator can still set roles individually afterwards, and the system
// neither remembers nor cares which preset was used.
//
// NO INDIVIDUAL IS NAMED HERE. Assigning a person to a preset is data an
// administrator enters, and stays that way.
// ---------------------------------------------------------------------------

export const ROLE_PRESETS = [
  {
    key: 'ORGANIZATION_ADMIN',
    labelKey: 'purchasing.preset.organization_admin',
    roles: ['ADMIN'],
    canApprove: true,
    description: 'Everything, including users, vendors, jobs and configuration.',
  },
  {
    key: 'PURCHASING_MANAGER',
    labelKey: 'purchasing.preset.purchasing_manager',
    roles: ['WORKSHOP_APPROVER'],
    canApprove: true,
    description: 'Reviews and decides requests, generates POs and vendor emails, marks orders placed.',
  },
  {
    key: 'APPROVER',
    labelKey: 'purchasing.preset.approver',
    roles: ['OFFICE'],
    canApprove: true,
    description: 'Office staff given approval authority, without the full purchasing role.',
  },
  {
    key: 'REQUESTER',
    labelKey: 'purchasing.preset.requester',
    roles: ['REQUESTOR'],
    canApprove: false,
    description: 'Raises and submits requests. Sees their own.',
  },
  {
    key: 'FIELD_FOREMAN',
    labelKey: 'purchasing.preset.field_foreman',
    roles: ['FOREMAN'],
    canApprove: false,
    description: 'Raises requests and signs for deliveries — on assigned jobs only.',
  },
  {
    key: 'ACCOUNTING_READ_ONLY',
    labelKey: 'purchasing.preset.accounting',
    roles: ['ACCOUNTING'],
    canApprove: false,
    description: 'Inspects completed purchasing records. Holds no write permission at all.',
  },
];

export function presetByKey(key) {
  return ROLE_PRESETS.find((p) => p.key === key) ?? null;
}

export const ROLE_PERMISSIONS = {
  REQUESTOR: REQUESTOR_PERMISSIONS,
  FOREMAN: FOREMAN_PERMISSIONS,
  OFFICE: OFFICE_PERMISSIONS,
  ACCOUNTING: ACCOUNTING_PERMISSIONS,
  WORKSHOP_APPROVER: WORKSHOP_APPROVER_PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
};

/**
 * Permissions an explicit approval GRANT adds, independent of role. This is how
 * an office employee is given approval authority without being handed the whole
 * workshop role (spec §2 OFFICE).
 */
export const APPROVAL_GRANT_PERMISSIONS = [
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
];

/** Fields on a request/line the requestor may never write. Spec §2, §14. */
export const REQUESTOR_FORBIDDEN_FIELDS = [
  'vendor_id',
  'estimated_unit_cost_cents',
  'estimated_line_total_cents',
  'usable_stock_qty',
  'approved_qty',
  'suggested_order_qty',
  'final_order_qty',
  'po_number',
  'priority', // removed by design — replaced by need_by_date + need_by_time
];

/** Effective permission set for a user. */
export function permissionsFor(user) {
  if (!user || !Array.isArray(user.roles)) return [];
  const set = new Set();
  for (const role of user.roles) {
    for (const p of ROLE_PERMISSIONS[role] ?? []) set.add(p);
  }
  if (user.canApprove) {
    for (const p of APPROVAL_GRANT_PERMISSIONS) set.add(p);
  }
  return [...set].sort();
}

export function hasPermission(user, permission) {
  return permissionsFor(user).includes(permission);
}

export function isApprover(user) {
  return hasPermission(user, 'review.decide');
}

export function isAdmin(user) {
  return Boolean(user && Array.isArray(user.roles) && user.roles.includes('ADMIN'));
}

/** Closed vocabulary of authorization denials. */
export const DENY_REASONS = [
  'no_session',
  'inactive_user',
  'unknown_permission',
  'missing_permission',
  'cross_tenant',
  'not_owner',
  'self_approval',
  'request_locked',
  'not_assigned',
];

/**
 * Permissions a field user may only exercise on a job they are assigned to. A
 * foreman signs for what lands on HIS site; he does not sign for the whole
 * company. Office and workshop staff are not scoped this way — receiving at the
 * shop counter is their job.
 */
const ASSIGNMENT_SCOPED = ['deliveries.confirm', 'receiving.record'];

function isFieldOnly(user) {
  const roles = user?.roles ?? [];
  return !roles.some((r) => ['OFFICE', 'ACCOUNTING', 'WORKSHOP_APPROVER', 'ADMIN'].includes(r));
}

/**
 * THE authorization decision. Every server mutation calls this first.
 *
 * @param {object|null} user    {id, orgId, roles[], canApprove, isActive}
 * @param {string} permission   one of PERMISSIONS
 * @param {object} [ctx]        {request, settings}
 * @returns {{ok:boolean, reason:string|null, message:string|null}}
 */
export function authorize(user, permission, ctx = {}) {
  if (!user || !user.id) return deny('no_session', 'not signed in');
  if (user.isActive === false) return deny('inactive_user', 'user is deactivated');
  if (!PERMISSIONS.includes(permission)) {
    return deny('unknown_permission', `unknown permission ${permission}`);
  }

  const request = ctx.request ?? null;

  // Tenant boundary first: a record from another org is invisible, whatever the
  // role says. Admin is not a cross-tenant role.
  if (request && request.orgId && user.orgId && request.orgId !== user.orgId) {
    return deny('cross_tenant', 'record belongs to another organization');
  }

  if (!hasPermission(user, permission)) {
    return deny('missing_permission', `role does not carry ${permission}`);
  }

  // Ownership: the ".own" permissions — and answering a clarification, which is
  // a question addressed to a specific person — only reach the caller's own
  // requests. Office staff can see and annotate everything; they cannot answer
  // on the foreman's behalf, because the answer is evidence of who said what.
  if (request && (permission.endsWith('.own') || OWNERSHIP_REQUIRED.includes(permission))) {
    const owns = request.requestorId === user.id || request.createdBy === user.id;
    if (!owns) return deny('not_owner', 'not the requestor of this request');
  }
  if (request && permission === 'request.read.own' && !hasPermission(user, 'request.read.all')) {
    const owns = request.requestorId === user.id || request.createdBy === user.id;
    if (!owns) return deny('not_owner', 'not the requestor of this request');
  }

  // Nobody decides on their own request unless the org explicitly allows it.
  // Default is OFF: an approver who raised the request is not an independent
  // reviewer of it. Configurable because a one-approver workshop may need it.
  if (request && DECISION_PERMISSIONS.includes(permission)) {
    const allowSelf = Boolean(ctx.settings && ctx.settings.allowSelfApproval);
    const owns = request.requestorId === user.id || request.createdBy === user.id;
    if (owns && !allowSelf) {
      return deny('self_approval', 'a request cannot be decided by the person who raised it');
    }
  }

  // Job-site delivery confirmation is scoped to the caller's assigned jobs.
  // The assignment list comes from the server (never from the browser).
  if (request && ASSIGNMENT_SCOPED.includes(permission) && isFieldOnly(user)) {
    const assigned = ctx.assignedJobNumbers ?? user.assignedJobNumbers ?? [];
    if (!assigned.includes(request.jobNumber)) {
      return deny('not_assigned', `job ${request.jobNumber} is not assigned to you`);
    }
  }

  // Requestor-side edits stop the moment the workshop owns the request.
  if (request && OWNER_EDIT_PERMISSIONS.includes(permission)) {
    const editable = ['DRAFT', 'CLARIFICATION_REQUESTED'].includes(request.status);
    if (!editable && !hasPermission(user, 'review.decide')) {
      return deny('request_locked', `a ${request.status} request is not editable by the requestor`);
    }
  }

  return { ok: true, reason: null, message: null };
}

const DECISION_PERMISSIONS = ['review.decide'];
const OWNER_EDIT_PERMISSIONS = ['request.update.own', 'request.submit'];
const OWNERSHIP_REQUIRED = ['request.respond_clarification'];

function deny(reason, message) {
  return { ok: false, reason, message };
}

/**
 * What the UI should offer for a request, given the viewer. Derived from the
 * same authorize() the server enforces, so an offered action always succeeds
 * and an unoffered one always fails — the two can never drift.
 */
export function availableActions(user, request, ctx = {}) {
  const settings = ctx.settings ?? {};
  const out = [];
  const allow = (action, permission) => {
    if (authorize(user, permission, { request, settings }).ok) out.push(action);
  };

  if (!request) return out;
  switch (request.status) {
    case 'DRAFT':
      allow('edit', 'request.update.own');
      allow('submit', 'request.submit');
      allow('cancel', 'request.cancel.own');
      break;
    case 'PENDING_WORKSHOP_REVIEW':
    case 'RESUBMITTED':
      allow('review', 'review.record_stock');
      allow('approve', 'review.decide');
      allow('reject', 'review.decide');
      allow('request_clarification', 'review.decide');
      break;
    case 'CLARIFICATION_REQUESTED':
      allow('respond', 'request.respond_clarification');
      allow('edit', 'request.update.own');
      break;
    case 'APPROVED':
      allow('generate_po', 'po.generate');
      break;
    case 'PO_GENERATED':
      allow('draft_email', 'email.draft');
      break;
    case 'EMAIL_DRAFTED':
      allow('review_email', 'email.review');
      allow('mark_ordered', 'order.mark_ordered');
      break;
    case 'ORDERED':
    case 'PARTIALLY_RECEIVED':
      allow('add_tracking', 'order.track');
      allow('receive', 'receiving.record');
      break;
    case 'RECEIVED':
      allow('complete', 'request.complete');
      break;
    default:
      break;
  }
  if (!['COMPLETED', 'CANCELLED', 'REJECTED'].includes(request.status)) {
    allow('cancel_any', 'request.cancel.any');
  }
  return out;
}

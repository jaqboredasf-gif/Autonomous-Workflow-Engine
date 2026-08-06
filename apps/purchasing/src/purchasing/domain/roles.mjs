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

export const ROLES = ['REQUESTOR', 'OFFICE', 'WORKSHOP_APPROVER', 'ADMIN'];

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
  // Administration
  'admin.users',
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

const ADMIN_PERMISSIONS = [...PERMISSIONS];

export const ROLE_PERMISSIONS = {
  REQUESTOR: REQUESTOR_PERMISSIONS,
  OFFICE: OFFICE_PERMISSIONS,
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
];

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

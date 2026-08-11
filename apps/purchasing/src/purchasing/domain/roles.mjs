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

import { availableActions as workflowActions } from '@awe/workflow';

import { PURCHASING_WORKFLOW } from './purchasing-workflow.mjs';
import { OPEN_ORDER_STATUSES, QUEUE_STATUSES, REQUESTOR_EDITABLE_STATUSES } from './status.mjs';

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
//
// THE CROSSWALK IS TOTAL, AND A TEST SAYS SO.
// Every permission in PERMISSIONS is reachable from at least one capability.
// A partial vocabulary is worse than none: it reads as the complete list of what
// the system can do, so the eighteen permissions it omitted — cancelling,
// answering a clarification, the whole workshop review, completing a request,
// adjusting inventory, signing for a delivery, the accounting packet, and every
// configuration screen — were authority nobody could name in a contract, a role
// description or an admin screen. `capability_crosswalk_total` in
// eval-purchasing-authorization.mjs fails the build if a permission is added
// without a capability that reaches it.
//
// A CAPABILITY NAME IS NEVER A PERMISSION NAME. The two namespaces are kept
// disjoint (also asserted) so that passing one where the other is expected
// fails closed at `authorize()` — which refuses an unknown permission — rather
// than silently authorizing.
//
// GRANULARITY RULE: a capability bundles permissions that are always held
// together by the same job. `hasCapability` requires ALL of them, so a bundle
// that mixes two jobs would report "no" for somebody who genuinely does one of
// them. That is why review and decide are separate, and why cancelling your own
// is separate from cancelling anybody's.
// ---------------------------------------------------------------------------

export const CAPABILITIES = {
  // --- raising and tracking a request --------------------------------------
  'purchase.request.create': ['request.create', 'request.submit'],
  'purchase.request.view': ['request.read.own'],
  'purchase.request.view.all': ['request.read.all'],
  'purchase.request.edit': ['request.update.own'],
  /** Attach evidence, leave a note, answer a question addressed to you. */
  'purchase.request.collaborate': ['request.attach', 'request.note', 'request.respond_clarification'],
  /** Withdraw your OWN request. Widened by ownership, never subtracted by it. */
  'purchase.request.cancel': ['request.cancel.own'],
  /** Cancel anybody's request in the organization. A purchasing authority. */
  'purchase.request.cancel.any': ['request.cancel.any'],

  // --- the workshop's work on a request ------------------------------------
  /**
   * Working the queue: reading it, recording usable stock, and setting the
   * quantities, vendor and cost a decision will be made against. Deliberately
   * NOT the decision itself — an office approver holds both through the grant,
   * but they are different jobs and a future role may hold only this one.
   */
  'purchase.request.review': [
    'review.read_queue', 'review.record_stock', 'review.set_quantities',
    'review.set_vendor', 'review.set_cost',
  ],
  'purchase.request.approve': ['review.decide'],
  /** Closing a request out once everything has arrived and been accounted for. */
  'purchase.request.complete': ['request.complete'],

  // --- ordering -------------------------------------------------------------
  'purchase.order.create': ['po.generate'],
  'purchase.order.manage': ['order.track', 'email.draft', 'email.review'],
  'purchase.order.mark_ordered': ['order.mark_ordered'],

  // --- what physically arrives ----------------------------------------------
  /** Recording a receipt: what actually turned up, and in what condition. */
  'receiving.confirm': ['receiving.record'],
  /** A foreman signing for a delivery on a job site. Scoped by assignment. */
  'delivery.sign_off': ['deliveries.confirm'],
  /** Correcting what the shop believes it holds. */
  'inventory.manage': ['inventory.adjust'],

  // --- money ----------------------------------------------------------------
  'accounting.view': ['accounting.read'],
  /** Assembling the evidence packet accounts payable pays an invoice against. */
  'accounting.export': ['accounting.packet'],

  // --- administration -------------------------------------------------------
  'vendor.manage': ['admin.vendors'],
  'job.manage': ['admin.assignments'],
  'user.manage': ['admin.users', 'admin.invite'],
  'audit.view': ['admin.audit'],
  /**
   * The organization's own configuration: email templates, PO numbering and
   * layout, delivery locations, and the purchasing settings. One capability,
   * because an administrator trusted with one of these is trusted with all of
   * them, and no role in ROLE_PERMISSIONS holds a strict subset.
   */
  'configuration.manage': ['admin.templates', 'admin.po_config', 'admin.locations', 'admin.settings'],
};

/**
 * BR-011's capability by name. The rule the business states is "a user with
 * approval authority may approve", and this is the name of that authority. It
 * resolves to `review.decide`, which is what authorize() actually enforces, so
 * naming it here adds a label — never a second, drift-prone gate.
 */
export const APPROVE_PURCHASE = 'purchase.request.approve';

/**
 * BR-014's capability by name. Receipt authority follows the capability and the
 * scope a person is authorized to verify — never the identity of whoever
 * requested or approved the order. Resolves to `receiving.record`, which is
 * what authorize() enforces.
 */
export const RECORD_RECEIPT = 'receiving.confirm';

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
    /**
     * Office staff WITHOUT approval authority. The preset list had no way to
     * set one up: the only OFFICE preset carried the approval grant, so every
     * administrator provisioning a coordinator had to pick APPROVER and then
     * remember to take the grant away. A preset that hands out more authority
     * than intended unless a second step is remembered is a defect, not a
     * shortcut.
     */
    key: 'OFFICE_COORDINATOR',
    labelKey: 'purchasing.preset.office_coordinator',
    roles: ['OFFICE'],
    canApprove: false,
    description: 'Sees every request, tracks orders and receives at the counter. Cannot approve.',
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

/**
 * BR-011: is this decision being made by the person who raised the request?
 *
 * NOT an authorization question — authorize() no longer asks it. It is an AUDIT
 * question: the approval record says so, the request detail can show it, and a
 * reviewer reading the history can see that one person stood on both sides of
 * it without having to compare two user ids by eye.
 *
 * OWNERSHIP-OK: AUDIT — records a fact, authorizes nothing.
 */
export function isSelfApproval(user, request) {
  if (!user || !user.id || !request) return false;
  return request.requestorId === user.id || request.createdBy === user.id;
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
  // 'self_approval' was removed by BR-011. Approval authority is a capability,
  // not a function of who raised the request, so no denial can carry that
  // reason any more. It is absent rather than unused on purpose: a reason left
  // in a closed vocabulary invites someone to start emitting it again.
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

/**
 * SHOP-COUNTER ROLES — the people for whom receiving is NOT job-scoped.
 *
 * Exported because one rule decides three things that must agree: whether
 * authorize() applies a job scope, which orders the receiving index lists, and
 * which deliveries a field user is shown. Those were three separate copies of
 * this array, and the day somebody adds a role to one of them the other two
 * silently disagree about who may sign for what.
 */
export const SHOP_COUNTER_ROLES = ['OFFICE', 'ACCOUNTING', 'WORKSHOP_APPROVER', 'ADMIN'];

/**
 * Is this user field-only — does their receiving authority stop at the
 * locations they are assigned to? Shop staff are not scoped: the counter is
 * their post.
 */
export function isFieldOnly(user) {
  const roles = user?.roles ?? [];
  return !roles.some((r) => SHOP_COUNTER_ROLES.includes(r));
}

/**
 * THE WORKSHOP, AS A PLACE SOMEBODY CAN BE ASSIGNED TO.
 *
 * A receiving assignment names a location. Job sites are named by their job
 * number; the workshop is named by this reserved key, and it travels through
 * exactly the same assignment mechanism — `purchasing_job_assignments`, one row
 * per person per location, which has always been a join table.
 *
 * WHY THIS EXISTS. Receiving scope used to be inferred entirely from ROLE:
 * office, accounting, workshop-approver and admin were unscoped, everybody else
 * was job-scoped. So a foreman who also works the shop counter could only be
 * given shop receiving authority by handing him an OFFICE or WORKSHOP_APPROVER
 * role — which carries approving, ordering and reading every request in the
 * company. Authority that should be DECLARED was being INFERRED, and the only
 * way to grant it was to grant far too much.
 *
 * With this, an administrator assigns the workshop the same way they assign
 * 24-118, and the foreman gains shop receiving and nothing else.
 *
 * IT IS RESERVED. No job may be numbered `WORKSHOP` — `isReservedLocation()`
 * below is what the admin write path checks, so a job number can never collide
 * with the key and silently confer shop authority.
 */
export const WORKSHOP_LOCATION = 'WORKSHOP';

/** Every location key that is not a job number. One place, so a second one is a change here. */
export const RESERVED_LOCATIONS = [WORKSHOP_LOCATION];

/** May this string be used as a job number? No, if it is a reserved location key. */
export function isReservedLocation(value) {
  return RESERVED_LOCATIONS.includes(String(value ?? '').trim().toUpperCase());
}

/**
 * What this person may sign for, as one answer.
 *
 * `unscoped` means every location in the organization — the shop-counter roles.
 * `locations` is what a field user was explicitly assigned: job numbers, and
 * possibly WORKSHOP_LOCATION.
 */
export function receivingScopeFor(user) {
  const assigned = user?.assignedJobNumbers ?? [];
  return {
    unscoped: !isFieldOnly(user),
    locations: [...new Set(assigned.map((l) => String(l).trim()).filter(Boolean))],
  };
}

/**
 * MAY THIS PERSON SIGN FOR SOMETHING ARRIVING HERE?
 *
 * The single predicate. `authorize()` asks it per record, the receiving index
 * asks it per row, and the deliveries index asks it per row — three call sites
 * that must agree, which is the same reason SHOP_COUNTER_ROLES was extracted.
 * They were re-deriving `isFieldOnly(user) && assigned.includes(jobNumber)`
 * separately, and the day the rule gained the workshop, two of the three would
 * have kept the old answer.
 *
 * @param {object} user
 * @param {{jobNumber?: string|null, locationKind?: string|null}} destination
 *        `locationKind` is `purchase_location_kind` — JOBSITE, WORKSHOP, OFFICE
 *        or VENDOR_PICKUP. When it is absent the destination is treated as the
 *        job site, which is what every record meant before this existed.
 */
export function mayReceiveAt(user, destination = {}) {
  const scope = receivingScopeFor(user);
  if (scope.unscoped) return true;

  const kind = destination?.locationKind ?? null;
  // Material delivered to the shop — or collected from a vendor and brought
  // back to it — is signed for by whoever holds the workshop assignment. It is
  // NOT signed for by a foreman assigned only to a job site, even the job the
  // material is destined for: he is not standing there.
  if (kind === 'WORKSHOP' || kind === 'OFFICE' || kind === 'VENDOR_PICKUP') {
    return scope.locations.includes(WORKSHOP_LOCATION);
  }

  const jobNumber = destination?.jobNumber ?? null;
  return Boolean(jobNumber) && scope.locations.includes(jobNumber);
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
  //
  // OWNERSHIP-OK: GRANTS — these permissions are DEFINED by ownership. The test
  // does not subtract authority from anyone: a user who needs to act on another
  // person's request uses a different permission (request.read.all,
  // request.cancel.any), which they either hold or do not.
  if (request && (permission.endsWith('.own') || OWNERSHIP_REQUIRED.includes(permission))) {
    const owns = request.requestorId === user.id || request.createdBy === user.id;
    if (!owns) return deny('not_owner', 'not the requestor of this request');
  }
  // OWNERSHIP-OK: GRANTS — the fallback for someone who cannot read everything:
  // they can still read their own. Anyone holding request.read.all skips it.
  if (request && permission === 'request.read.own' && !hasPermission(user, 'request.read.all')) {
    const owns = request.requestorId === user.id || request.createdBy === user.id;
    if (!owns) return deny('not_owner', 'not the requestor of this request');
  }

  // BR-011: APPROVAL AUTHORITY SUPERSEDES REQUESTER IDENTITY.
  //
  // There is deliberately NO ownership test here. Whether a decision is allowed
  // is decided by one thing — does this user hold the approval capability
  // (`review.decide`, i.e. APPROVE_PURCHASE) — and the check above already
  // answered it. A purchaser who raises a request is still a purchaser: in a
  // contracting business the people holding purchasing authority are usually
  // the same people who need the material.
  //
  // The rule that used to live here was `created_by == current_user -> deny`.
  // It refused the ordinary case — a buyer ordering what the buyer needs — to
  // prevent an abuse the capability grant already controls: a user who must not
  // approve is not given `review.decide` in the first place — see the REQUESTER
  // and FIELD_FOREMAN presets, which carry canApprove: false.
  //
  // Self-approval is not hidden, it is RECORDED: decisions.ts stamps
  // `selfApproved` on the approval row (and the SQL RPC does the same), so the
  // audit trail names the requester and the approver even when they are the
  // same person. See isSelfApproval() below.

  // BR-014: RECEIPT AUTHORITY FOLLOWS CAPABILITY AND VERIFIED POSSESSION.
  //
  // Note what is NOT tested anywhere on this path: who raised the request and
  // who approved it. A purchaser may receive an order they requested, and one
  // they approved — signing for material that physically arrived is a statement
  // about a delivery, not a second approval of the purchase, so the identity
  // rules that govern approval have no business here.
  //
  // What IS tested is scope: a field user signs for what lands on the sites
  // they are assigned to. Shop staff are not scoped, because receiving at the
  // shop counter is their job and the counter is not a job site. The assignment
  // list comes from the server (never from the browser).
  // The workshop is one of those locations, assigned explicitly rather than
  // inferred from a role — see WORKSHOP_LOCATION. mayReceiveAt() is the only
  // place the rule is written; this passes it the record's destination.
  if (request && ASSIGNMENT_SCOPED.includes(permission)) {
    const scoped = ctx.assignedJobNumbers
      ? { ...user, assignedJobNumbers: ctx.assignedJobNumbers }
      : user;
    const destination = { jobNumber: request.jobNumber, locationKind: request.deliveryLocationKind ?? null };
    if (!mayReceiveAt(scoped, destination)) {
      return deny('not_assigned', destination.locationKind === 'WORKSHOP'
        ? 'the workshop is not assigned to you'
        : `job ${request.jobNumber} is not assigned to you`);
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

const OWNER_EDIT_PERMISSIONS = ['request.update.own', 'request.submit'];
const OWNERSHIP_REQUIRED = ['request.respond_clarification'];

function deny(reason, message) {
  return { ok: false, reason, message };
}

/**
 * BR-014: WHY receiving is unavailable, when it is.
 *
 * The receiving screen used to answer this with one sentence covering three
 * unrelated situations — "either it is not awaiting delivery, or it is on a job
 * you are not assigned to". A person holding full receipt authority, looking at
 * an order that had simply already been received, was told they might not be
 * allowed to touch it. That reads as an authority problem and sends them to ask
 * for a permission they already have.
 *
 * These are three different facts and they get three different answers:
 *
 *   no_capability   this person cannot record receipts at all
 *   not_assigned    they can, but not on this job site
 *   not_receivable  they can, on this order — it is not awaiting delivery
 *   cross_tenant    another organization's record (already refused upstream)
 *
 * Returns {ok: true} when receiving IS available. The server re-decides with
 * the record in hand; this exists so the screen can say something true.
 *
 * @param {object|null} user
 * @param {object|null} request
 * @param {object} [ctx]  {settings, assignedJobNumbers}
 */
export function receivingAvailability(user, request, ctx = {}) {
  const decision = authorize(user, 'receiving.record', { ...ctx, request });
  if (!decision.ok) {
    // authorize()'s vocabulary already distinguishes these; `missing_permission`
    // is renamed here to the thing a reader of this answer cares about.
    const reason = decision.reason === 'missing_permission' ? 'no_capability' : decision.reason;
    return { ok: false, reason, message: decision.message };
  }
  if (!request) return { ok: true, reason: null, message: null };
  if (!OPEN_ORDER_STATUSES.includes(request.status)) {
    return {
      ok: false,
      reason: 'not_receivable',
      message: `a ${request.status} order is not awaiting delivery`,
    };
  }
  return { ok: true, reason: null, message: null };
}

/**
 * What the UI should offer for a request, given the viewer. Derived from the
 * same authorize() the server enforces, so an offered action always succeeds
 * and an unoffered one always fails — the two can never drift.
 */
export function availableActions(user, request, ctx = {}) {
  const settings = ctx.settings ?? {};
  if (!request) return [];

  const facts = ctx.facts ?? {};
  const out = [];

  // --- TRANSITIONS: the workflow definition decides, not this file ---------
  //
  // THE DEFECT THIS REMOVES. This function used to be a switch over statuses
  // listing which actions each one offered — a second, hand-maintained copy of
  // the transition graph. It could drift from the server in both directions,
  // and it did in one: it offered `approve` on any queued request whether or
  // not a workshop review had been saved, so the button was there and the
  // server refused it with `review_incomplete`.
  //
  // Now the same PURCHASING_WORKFLOW that executes the transition decides
  // whether to offer it, with the same permissions and the same evidence. An
  // offered action is one that would succeed.
  //
  // The UI names are kept stable and mapped here: what to CALL an action is a
  // presentation concern and has no business in the workflow definition.
  const offered = workflowActions({
    workflow: PURCHASING_WORKFLOW,
    from: request.status,
    facts: { ...facts, isOwner: request.requestorId === user?.id || request.createdBy === user?.id },
    can: (permission) => authorize(user, permission, { request, settings }).ok,
  });

  for (const { action } of offered) {
    // `queue` is systemic — it has no permission and no button, and offering it
    // would put an action on screen that no human is meant to take.
    if (action === 'queue') continue;
    if (action === 'cancel') {
      // One workflow action, two UI names, because the screens have always
      // distinguished "withdraw mine" from "cancel somebody else's".
      const owns = request.requestorId === user?.id || request.createdBy === user?.id;
      out.push(owns ? 'cancel' : 'cancel_any');
      continue;
    }
    const label = UI_ACTION_NAMES[action];
    if (label && !out.includes(label)) out.push(label);
  }

  // --- NON-TRANSITION ACTIONS ----------------------------------------------
  //
  // These change no state, so the workflow has nothing to say about them and
  // they stay listed here: editing a draft, opening the review screen, reading
  // the vendor email, entering a tracking number. Each is still authorized.
  const allow = (action, permission) => {
    if (!out.includes(action) && authorize(user, permission, { request, settings }).ok) out.push(action);
  };
  if (REQUESTOR_EDITABLE_STATUSES.includes(request.status)) allow('edit', 'request.update.own');
  if (QUEUE_STATUSES.includes(request.status)) allow('review', 'review.record_stock');
  if (request.status === 'EMAIL_DRAFTED') allow('review_email', 'email.review');
  if (OPEN_ORDER_STATUSES.includes(request.status)) allow('add_tracking', 'order.track');

  return out;
}

/**
 * Workflow action -> the name the screens have always used for it.
 *
 * Presentation, deliberately kept out of the workflow definition: the engine
 * should not know that this product calls `requestClarification` "request
 * clarification", and a rename here must not be able to change what is legal.
 */
const UI_ACTION_NAMES = Object.freeze({
  submit: 'submit',
  approve: 'approve',
  reject: 'reject',
  requestClarification: 'request_clarification',
  answerClarification: 'respond',
  generatePo: 'generate_po',
  draftEmail: 'draft_email',
  markOrdered: 'mark_ordered',
  // Both receipt actions are the same button; which one fires depends on the
  // quantities, which the receiving screen decides after the counting.
  recordPartialReceipt: 'receive',
  recordFullReceipt: 'receive',
  complete: 'complete',
});


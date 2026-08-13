/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// administration.ts — the two settings that change how purchasing BEHAVES.
//
// Approval authority is a purchasing concern (who may decide a purchase), so it
// lives here. General user administration, role infrastructure and tenant
// management are NOT purchasing's: this file only flips the purchasing grant on
// a user the platform already owns.
// ---------------------------------------------------------------------------

import { emit, must, PurchasingError, type PurchasingContext } from './context.ts';
import type { Actor } from './ports.ts';
import { events } from '../domain/events.mjs';
import {
  FIRST_SEQUENCE, normalizeJobSegment, planSequenceInitialization, validateVendorCode,
} from '../domain/po-number.mjs';
import { isReservedLocation, ROLES, WORKSHOP_LOCATION } from '../domain/roles.mjs';

// ===========================================================================
// PURCHASE ORDER NUMBERING.
//
// The organization's numbering rule is not configured from this screen — it is
// established once, in the organization's profile, and implemented behind
// domain/po-number-strategy.mjs. There is no prefix, no padding and no
// company-wide starting number to set, so the two use cases here are the only
// two an administrator has:
//
//   * read what each pair stands at, and
//   * declare where a pair ALREADY stood, because the office wrote purchase
//     orders for it on paper before PCC existed.
//
// The second is the dangerous one and is written to be dull: forward only,
// never below what PCC itself has issued, always attributable.
// ===========================================================================

/** What every (job, vendor) pair this organization counts stands at. */
export async function poSequences(ctx: PurchasingContext, actor: Actor) {
  await must(ctx, actor, 'admin.po_config');
  return await ctx.poNumbers.sequences(actor.orgId);
}

/**
 * Line one (job, vendor) pair up with the office's paper book — or record that
 * it has no paper behind it.
 *
 * Both are declarations, and both are useful. A pair the office has already
 * written orders for must be told where it had reached, or PCC's first number
 * collides with one the supplier holds. A pair with NO paper history is
 * declared by saying its next number is 1: nothing changes about how it counts,
 * but the pair stops being an open question, and `pcc-verify-production.mjs`
 * stops asking about it before go-live. That is the whole difference between
 * "nobody has checked this job" and "the office checked, and it is new".
 *
 * The administrator gives EITHER the last number they issued or the next one —
 * both are things a person actually knows, and requiring exactly one of them
 * means a half-filled form cannot be mistaken for an answer.
 */
export async function initializePoSequence(
  ctx: PurchasingContext, actor: Actor,
  input: {
    jobNumber?: string; vendorId?: string;
    lastIssuedSequence?: string | number; nextSequence?: string | number;
    /**
     * Required only when PCC has ALREADY issued purchase orders for this pair.
     * Moving such a pair is legitimate — an office correcting a gap — but it is
     * never something to do by accident, so the caller has to have seen the
     * count and said so.
     */
    acknowledgeIssued?: boolean;
  },
) {
  await must(ctx, actor, 'admin.po_config');

  const jobNumber = normalizeJobSegment(input.jobNumber);
  if (!jobNumber) throw new PurchasingError('validation_failed', 'which job? A purchase order sequence belongs to a job and a vendor.');

  const vendor = await ctx.reference.vendorById(actor.orgId, String(input.vendorId ?? ''));
  if (!vendor) throw new PurchasingError('not_found', 'vendor not found');
  if (!vendor.code) throw new PurchasingError('vendor_code_missing', `${vendor.name} has no purchase order code yet`);

  // WHAT PCC ITSELF HAS ALREADY PUT ON A SUPPLIER'S PAPERWORK. Read from the
  // issued orders rather than from the counter: the counter is where the next
  // one comes from, and this is the floor the declaration may not go under.
  const issuedSequence = await ctx.poNumbers.highestIssued({ orgId: actor.orgId, jobNumber, vendorId: vendor.id });

  const plan = planSequenceInitialization({
    lastIssuedSequence: input.lastIssuedSequence,
    nextSequence: input.nextSequence,
    issuedSequence,
  });
  if (!plan.ok) throw new PurchasingError(plan.reason as string, plan.message as string);

  const nextValue = plan.nextValue as number;

  // NOT SILENTLY, OVER REAL ORDERS. `planSequenceInitialization` already refuses
  // to land on or below a number PCC has issued; this covers the other half —
  // a pair with real purchase orders behind it being moved FORWARD. That is a
  // legitimate act (an office reconciling a gap after an outage) and a terrible
  // accident, and the two are told apart by whether the person knew the orders
  // were there.
  if (issuedSequence > 0 && !input.acknowledgeIssued) {
    throw new PurchasingError(
      'sequence_already_issued',
      `PCC has already issued ${issuedSequence} purchase order number(s) for job ${jobNumber} with ${vendor.name}, ` +
        `the most recent being ${ctx.poNumbers.preview({ orgId: actor.orgId, jobNumber, vendorId: vendor.id, vendorCode: String(vendor.code).toUpperCase() }, issuedSequence)}. ` +
        'Setting this pair is still possible, but it has to be deliberate — confirm that you mean to move a sequence ' +
        'that is already in use.',
    );
  }

  const before = (await ctx.poNumbers.sequences(actor.orgId))
    .find((s: any) => s.job_number === jobNumber && s.vendor_id === vendor.id) as any;
  if (before && Number(before.next_value) > nextValue) {
    throw new PurchasingError(
      'sequence_rewind',
      `this job and vendor are already at ${before.next_value}. A sequence can only move forward — issued numbers are permanent.`,
    );
  }

  const now = ctx.clock.now();
  await ctx.uow.run(() =>
    ctx.poNumbers.initialize(
      { orgId: actor.orgId, jobNumber, vendorId: vendor.id, vendorCode: String(vendor.code).toUpperCase() },
      nextValue,
      actor.id,
      now,
    ),
  );

  await emit(ctx, actor, actor.orgId, [
    events.poSequenceInitialized(
      { jobNumber, vendorId: vendor.id, vendorName: vendor.name, vendorCode: vendor.code },
      // `issued` goes on the record too: months later, the question about a
      // moved sequence is always "what was already out there when they moved
      // it", and that is not recoverable from the before/after alone.
      { from: before ? Number(before.next_value) : null, to: nextValue, issued: issuedSequence },
    ),
  ]);
  return {
    ok: true,
    nextValue,
    issuedSequence,
    /** True when this pair was declared to have no paper history behind it. */
    declaredNew: nextValue === FIRST_SEQUENCE,
    // Shown through the allocator, which is where the organization's numbering
    // rule is bound. This screen does not know the shape of a number.
    nextPoNumber: ctx.poNumbers.preview(
      { orgId: actor.orgId, jobNumber, vendorId: vendor.id, vendorCode: String(vendor.code).toUpperCase() },
      nextValue,
    ),
  };
}

// --- user administration ----------------------------------------------------
//
// Purchasing does not own identity, so these use cases do two things: write the
// purchasing-side facts (roles, assignments, receiver designation) and ask the
// AuthPort to do the credential-side ones (create, set password, disable).
// No password is ever written to a purchasing table by any of them.

export type InviteInput = {
  fullName: string;
  email: string;
  roles: string[];
  temporaryPassword: string;
  canApprove?: boolean;
  isDeliveryReceiver?: boolean;
  jobNumbers?: string[];
};

export async function inviteUser(ctx: PurchasingContext, actor: Actor, input: InviteInput) {
  await must(ctx, actor, 'admin.invite');
  if (!input.fullName?.trim() || !input.email?.trim()) {
    throw new PurchasingError('validation_failed', 'a name and an email address are required');
  }
  if (!input.roles?.length) throw new PurchasingError('validation_failed', 'give the person at least one role');
  if (!input.temporaryPassword || input.temporaryPassword.length < 10) {
    throw new PurchasingError('validation_failed', 'the temporary password must be at least 10 characters');
  }
  for (const role of input.roles) {
    if (!ROLES.includes(role)) throw new PurchasingError('validation_failed', `unknown role ${role}`);
  }

  const userId = await ctx.identity.createUser({
    orgId: actor.orgId,
    fullName: input.fullName.trim(),
    email: input.email.trim().toLowerCase(),
    roles: input.roles,
    canApprove: Boolean(input.canApprove),
    isDeliveryReceiver: Boolean(input.isDeliveryReceiver),
    createdBy: actor.id,
    now: ctx.clock.now(),
  });

  // Credentials are the provider's business, not ours.
  await ctx.auth.setPassword(userId, input.temporaryPassword);

  for (const jobNumber of input.jobNumbers ?? []) {
    await ctx.identity.assignJob(userId, jobNumber, actor.id, ctx.clock.now());
  }

  await emit(ctx, actor, actor.orgId, [
    events.approvalAuthorityChanged(userId, null, { invited: true, roles: input.roles }, `invited ${input.fullName}`),
  ]);
  return { userId };
}

/** Disable or re-enable an account, on both sides at once. */
export async function setUserDisabled(ctx: PurchasingContext, actor: Actor, userId: string, disabled: boolean) {
  await must(ctx, actor, 'admin.users');
  const target = await ctx.identity.load(userId);
  if (!target || target.orgId !== actor.orgId) throw new PurchasingError('not_found', 'user not found');
  if (userId === actor.id && disabled) {
    throw new PurchasingError('validation_failed', 'you cannot disable your own account');
  }

  await ctx.identity.setActive(userId, !disabled, actor.id, ctx.clock.now());
  await ctx.auth.setDisabled(userId, disabled);

  await emit(ctx, actor, actor.orgId, [
    events.approvalAuthorityChanged(
      userId, { active: target.isActive }, { active: !disabled },
      `${disabled ? 'disabled' : 're-enabled'} ${target.name}`,
    ),
  ]);
  return { ok: true };
}

/** Reset access: set a new temporary password through the provider. */
export async function resetUserAccess(ctx: PurchasingContext, actor: Actor, userId: string, temporaryPassword: string) {
  await must(ctx, actor, 'admin.users');
  const target = await ctx.identity.load(userId);
  if (!target || target.orgId !== actor.orgId) throw new PurchasingError('not_found', 'user not found');
  if (!temporaryPassword || temporaryPassword.length < 10) {
    throw new PurchasingError('validation_failed', 'the temporary password must be at least 10 characters');
  }
  await ctx.auth.setPassword(userId, temporaryPassword);
  await emit(ctx, actor, actor.orgId, [
    events.approvalAuthorityChanged(userId, null, { accessReset: true }, `reset access for ${target.name}`),
  ]);
  return { ok: true };
}

export async function setUserRoles(ctx: PurchasingContext, actor: Actor, userId: string, roles: string[]) {
  await must(ctx, actor, 'admin.users');
  const target = await ctx.identity.load(userId);
  if (!target || target.orgId !== actor.orgId) throw new PurchasingError('not_found', 'user not found');
  for (const role of roles) {
    if (!ROLES.includes(role)) throw new PurchasingError('validation_failed', `unknown role ${role}`);
  }
  if (!roles.length) throw new PurchasingError('validation_failed', 'a user needs at least one role');
  // Removing your own administration is a locked-out-of-the-building move.
  if (userId === actor.id && !roles.includes('ADMIN')) {
    throw new PurchasingError('validation_failed', 'you cannot remove your own administrator role');
  }

  await ctx.identity.setRoles(userId, roles, actor.id, ctx.clock.now());
  await emit(ctx, actor, actor.orgId, [
    events.approvalAuthorityChanged(userId, { roles: target.roles }, { roles }, `roles changed for ${target.name}`),
  ]);
  return { ok: true };
}

/**
 * Assign or unassign somebody to a LOCATION they may sign for deliveries at:
 * a job number, or the workshop (`WORKSHOP_LOCATION`).
 *
 * The location is CHECKED TO EXIST. It used to be free text, so a typo — `24-18`
 * for `24-118` — was accepted silently, and the foreman then saw an empty
 * deliveries list with nothing anywhere saying why. An assignment to a job
 * nobody has is not an assignment; it is a support call three weeks later.
 */
export async function setJobAssignment(
  ctx: PurchasingContext, actor: Actor, userId: string, jobNumber: string, assigned: boolean,
) {
  await must(ctx, actor, 'admin.assignments');
  const target = await ctx.identity.load(userId);
  if (!target || target.orgId !== actor.orgId) throw new PurchasingError('not_found', 'user not found');
  if (!jobNumber?.trim()) throw new PurchasingError('validation_failed', 'a job number is required');

  const location = jobNumber.trim();
  const isWorkshop = isReservedLocation(location);
  if (isWorkshop) {
    // Normalized so 'workshop' and 'Workshop' cannot become two different
    // assignments, only one of which the scope check would recognise.
    jobNumber = WORKSHOP_LOCATION;
  } else if (assigned) {
    // Only on the way IN. Unassigning must always work, including for a bad row
    // written before this check existed — otherwise the mistake is permanent.
    const job = await ctx.reference.jobByNumber(actor.orgId, location);
    if (!job) {
      throw new PurchasingError('validation_failed',
        `there is no job ${location} in this organization — add it to the job directory first`);
    }
  }

  if (assigned) await ctx.identity.assignJob(userId, isWorkshop ? WORKSHOP_LOCATION : location, actor.id, ctx.clock.now());
  else await ctx.identity.unassignJob(userId, isWorkshop ? WORKSHOP_LOCATION : location);

  await emit(ctx, actor, actor.orgId, [
    events.approvalAuthorityChanged(
      userId, { assignedJobNumbers: target.assignedJobNumbers },
      { jobNumber, assigned }, `${assigned ? 'assigned' : 'unassigned'} ${target.name} ${assigned ? 'to' : 'from'} job ${jobNumber}`,
    ),
  ]);
  return { ok: true };
}

/** Designate (or undesignate) someone as a delivery receiver. */
export async function setDeliveryReceiver(ctx: PurchasingContext, actor: Actor, userId: string, isReceiver: boolean) {
  await must(ctx, actor, 'admin.assignments');
  const target = await ctx.identity.load(userId);
  if (!target || target.orgId !== actor.orgId) throw new PurchasingError('not_found', 'user not found');
  await ctx.identity.setDeliveryReceiver(userId, isReceiver, actor.id, ctx.clock.now());
  await emit(ctx, actor, actor.orgId, [
    events.approvalAuthorityChanged(
      userId, { isDeliveryReceiver: target.isDeliveryReceiver }, { isDeliveryReceiver: isReceiver },
      `${isReceiver ? 'designated' : 'removed'} ${target.name} as a delivery receiver`,
    ),
  ]);
  return { ok: true };
}

/** Grant or revoke purchasing approval authority for a user in this org. */
export async function setApprovalAuthority(ctx: PurchasingContext, actor: Actor, userId: string, canApprove: boolean) {
  await must(ctx, actor, 'admin.users');
  const target = await ctx.identity.load(userId);
  if (!target || target.orgId !== actor.orgId) throw new PurchasingError('not_found', 'user not found');

  await ctx.reference.setApprovalAuthority(userId, canApprove, actor.id, ctx.clock.now());
  await emit(ctx, actor, actor.orgId, [
    events.approvalAuthorityChanged(
      userId, { canApprove: target.canApprove }, { canApprove },
      `approval authority ${canApprove ? 'granted to' : 'revoked from'} ${target.name}`,
    ),
  ]);
  return { ok: true };
}

// ===========================================================================
// THE DIRECTORIES — vendors and jobs.
//
// These are the two things a new organization must be able to configure before
// it can place a single order, and the two things that previously required a
// developer to insert rows. That is the whole difference between a product and
// a bespoke install, so they are use cases like any other: authorized,
// validated, audited.
//
// Neither is ever hard-deleted. A vendor that has appeared on a purchase order
// and a job that has appeared on a request are part of the historical record;
// they are DEACTIVATED so they stop being offered while what they explain stays
// intact.
// ===========================================================================

export type VendorInput = {
  name?: string; code?: string; accountNumber?: string; phone?: string; address?: string; notes?: string;
  contactName?: string; contactEmail?: string; contactPhone?: string;
};

function cleanVendor(input: VendorInput) {
  const name = (input.name ?? '').trim();
  if (!name) throw new PurchasingError('validation_failed', 'a vendor needs a name');
  if (name.length > 200) throw new PurchasingError('validation_failed', 'that vendor name is too long');

  // An address that a purchase order is mailed to, and an email a draft is
  // addressed to, are worth one sanity check each. Both stay optional: a
  // counter account at a local supply house may have neither.
  const contactEmail = (input.contactEmail ?? '').trim();
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    throw new PurchasingError('validation_failed', 'that contact email address is not a valid address');
  }
  return {
    name,
    accountNumber: (input.accountNumber ?? '').trim() || null,
    phone: (input.phone ?? '').trim() || null,
    address: (input.address ?? '').trim() || null,
    notes: (input.notes ?? '').trim() || null,
    contactName: (input.contactName ?? '').trim() || null,
    contactEmail: contactEmail || null,
    contactPhone: (input.contactPhone ?? '').trim() || null,
  };
}

export async function createVendor(ctx: PurchasingContext, actor: Actor, input: VendorInput) {
  await must(ctx, actor, 'admin.vendors');
  const v = cleanVendor(input);

  // Checked before writing so the operator gets "you already have one of those"
  // rather than a constraint violation from three layers down.
  const existing = await ctx.reference.vendorByName(actor.orgId, v.name);
  if (existing) {
    throw new PurchasingError('duplicate', `this organization already has a vendor called ${v.name}`);
  }

  // THE PO CODE, if the administrator supplied one. Blank means "derive it from
  // the name", which the repository does — the derivation is one function and
  // lives in the domain, not here and not in two providers.
  let code: string | null = null;
  if ((input.code ?? '').trim()) {
    const validation = validateVendorCode(input.code);
    if (!validation.ok) throw new PurchasingError('validation_failed', validation.errors[0].message, validation.errors);
    const clash = await ctx.reference.vendorByCode(actor.orgId, validation.value);
    if (clash) throw new PurchasingError('duplicate', `${clash.name} already uses the code ${validation.value}`);
    code = validation.value;
  }

  const now = ctx.clock.now();
  const vendorId = await ctx.uow.run(async () => {
    const id = await ctx.reference.createVendor(actor.orgId, { ...v, code }, actor.id, now);
    if (v.contactName || v.contactEmail || v.contactPhone) {
      await ctx.reference.setVendorPrimaryContact(actor.orgId, id, {
        name: v.contactName, email: v.contactEmail, phone: v.contactPhone,
      }, now);
    }
    return id;
  });

  await emit(ctx, actor, actor.orgId, [
    events.vendorCreated(vendorId, v, `added vendor ${v.name}`),
  ]);
  return { ok: true, vendorId };
}

export async function updateVendor(
  ctx: PurchasingContext, actor: Actor, vendorId: string, input: VendorInput,
) {
  await must(ctx, actor, 'admin.vendors');
  const before = (await ctx.reference.vendors(actor.orgId)).find((v: any) => v.id === vendorId);
  if (!before) throw new PurchasingError('not_found', 'vendor not found');
  const v = cleanVendor({ ...before, ...input, name: input.name ?? before.name });

  if (v.name !== before.name) {
    const clash = await ctx.reference.vendorByName(actor.orgId, v.name);
    if (clash && clash.id !== vendorId) {
      throw new PurchasingError('duplicate', `this organization already has a vendor called ${v.name}`);
    }
  }

  const now = ctx.clock.now();
  await ctx.uow.run(async () => {
    await ctx.reference.updateVendor(actor.orgId, vendorId, v, actor.id, now);
    if (input.contactName !== undefined || input.contactEmail !== undefined || input.contactPhone !== undefined) {
      await ctx.reference.setVendorPrimaryContact(actor.orgId, vendorId, {
        name: v.contactName, email: v.contactEmail, phone: v.contactPhone,
      }, now);
    }
  });

  await emit(ctx, actor, actor.orgId, [
    events.vendorUpdated(vendorId, { name: before.name }, v, `updated vendor ${v.name}`),
  ]);
  return { ok: true };
}

/**
 * Set the code this vendor is known by inside purchase order numbers.
 *
 * ALLOWED ONLY UNTIL THE FIRST ORDER. After that the code is on a supplier's
 * paperwork, in their system and on their invoices, and changing it would make
 * 1234-COOPER-2 the successor to a 1234-COOPERELECTRIC-1 that no longer appears
 * to exist. The display name stays freely editable — that is the point of
 * keeping the two apart.
 */
export async function setVendorCode(ctx: PurchasingContext, actor: Actor, vendorId: string, code: string) {
  await must(ctx, actor, 'admin.vendors');
  const vendor = await ctx.reference.vendorById(actor.orgId, vendorId);
  if (!vendor) throw new PurchasingError('not_found', 'vendor not found');

  const validation = validateVendorCode(code);
  if (!validation.ok) throw new PurchasingError('validation_failed', validation.errors[0].message, validation.errors);
  if (validation.value === String(vendor.code ?? '').toUpperCase()) return { ok: true, code: validation.value };

  if (await ctx.reference.vendorHasOrders(actor.orgId, vendorId)) {
    throw new PurchasingError(
      'vendor_code_frozen',
      `${vendor.name} has already been sent purchase orders as ${vendor.code}. That code is part of every number it carries and cannot be changed.`,
    );
  }

  const clash = await ctx.reference.vendorByCode(actor.orgId, validation.value);
  if (clash && clash.id !== vendorId) {
    throw new PurchasingError('duplicate', `${clash.name} already uses the code ${validation.value}`);
  }

  const now = ctx.clock.now();
  await ctx.reference.setVendorCode(actor.orgId, vendorId, validation.value, actor.id, now);
  await emit(ctx, actor, actor.orgId, [
    events.vendorUpdated(
      vendorId, { code: vendor.code ?? null }, { code: validation.value },
      `set the purchase order code for ${vendor.name} to ${validation.value}`,
    ),
  ]);
  return { ok: true, code: validation.value };
}

/**
 * Retire or restore a vendor. Never a delete: a vendor named on a past purchase
 * order has to stay resolvable, or the order stops explaining itself.
 */
export async function setVendorActive(
  ctx: PurchasingContext, actor: Actor, vendorId: string, isActive: boolean,
) {
  await must(ctx, actor, 'admin.vendors');
  const now = ctx.clock.now();
  await ctx.reference.updateVendor(actor.orgId, vendorId, { isActive }, actor.id, now);
  await emit(ctx, actor, actor.orgId, [
    events.vendorUpdated(vendorId, { isActive: !isActive }, { isActive },
      `${isActive ? 'restored' : 'retired'} a vendor`),
  ]);
  return { ok: true };
}

export type JobInput = {
  jobNumber?: string; name?: string; customer?: string; siteAddress?: string;
  deliveryInstructions?: string; status?: string; costCode?: string;
};

const JOB_STATUSES = ['ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED'];

function cleanJob(input: JobInput) {
  const jobNumber = (input.jobNumber ?? '').trim();
  const name = (input.name ?? '').trim();
  if (!jobNumber) throw new PurchasingError('validation_failed', 'a job needs a job number');
  if (!name) throw new PurchasingError('validation_failed', 'a job needs a name');
  const status = (input.status ?? 'ACTIVE').trim().toUpperCase();
  if (!JOB_STATUSES.includes(status)) {
    throw new PurchasingError('validation_failed', `${status} is not a job status`);
  }
  return {
    jobNumber, name, status,
    customer: (input.customer ?? '').trim() || null,
    siteAddress: (input.siteAddress ?? '').trim() || null,
    deliveryInstructions: (input.deliveryInstructions ?? '').trim() || null,
    costCode: (input.costCode ?? '').trim() || null,
  };
}

export async function createJob(ctx: PurchasingContext, actor: Actor, input: JobInput) {
  await must(ctx, actor, 'admin.assignments');
  const j = cleanJob(input);

  // A job numbered WORKSHOP would confer shop receiving authority on everybody
  // assigned to it — the reserved key means "the shop counter" to the scope
  // check, and it cannot tell the two apart. Migration 0034 states the same
  // refusal as a CHECK constraint, for every client that is not this one.
  if (isReservedLocation(j.jobNumber)) {
    throw new PurchasingError('validation_failed',
      `${j.jobNumber} is a reserved location name and cannot be used as a job number`);
  }

  const existing = await ctx.reference.jobByNumber(actor.orgId, j.jobNumber);
  if (existing) {
    throw new PurchasingError('duplicate', `job ${j.jobNumber} already exists`);
  }

  const now = ctx.clock.now();
  const jobId = await ctx.reference.createJob(actor.orgId, j, actor.id, now);
  await emit(ctx, actor, actor.orgId, [
    events.jobCreated(jobId, j, `added job ${j.jobNumber} — ${j.name}`),
  ]);
  return { ok: true, jobId };
}

export async function updateJob(
  ctx: PurchasingContext, actor: Actor, jobId: string, input: JobInput,
) {
  await must(ctx, actor, 'admin.assignments');
  const before = (await ctx.reference.jobs(actor.orgId)).find((j: any) => String(j.id) === String(jobId));
  if (!before) throw new PurchasingError('not_found', 'job not found');

  // The job NUMBER is deliberately not editable here. It is written onto every
  // request and purchase order as text; changing it would orphan them from the
  // job they belong to. Retire the job and create the replacement instead.
  const j = cleanJob({
    ...before,
    ...input,
    jobNumber: before.job_number ?? before.jobNumber,
    siteAddress: input.siteAddress ?? before.address ?? before.site_address,
  });

  const now = ctx.clock.now();
  await ctx.reference.updateJob(actor.orgId, jobId, j, actor.id, now);
  await emit(ctx, actor, actor.orgId, [
    events.jobUpdated(jobId, { name: before.name, status: before.status }, j, `updated job ${j.jobNumber}`),
  ]);
  return { ok: true };
}

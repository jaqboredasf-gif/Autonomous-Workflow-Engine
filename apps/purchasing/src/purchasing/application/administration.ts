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
import { validatePoConfig } from '../domain/po-number.mjs';
import { isReservedLocation, ROLES, WORKSHOP_LOCATION } from '../domain/roles.mjs';

export async function poConfig(ctx: PurchasingContext, actor: Actor) {
  return await ctx.reference.poConfig(actor.orgId);
}

/**
 * Change the PO numbering scheme. The next value may only move FORWARD:
 * winding a sequence backwards would re-issue numbers that vendors and invoices
 * already reference.
 */
export async function updatePoConfig(
  ctx: PurchasingContext, actor: Actor,
  input: { prefix?: string; padding?: number; suffix?: string; nextValue?: number },
) {
  await must(ctx, actor, 'admin.po_config');
  const current = await ctx.reference.poConfig(actor.orgId);

  const validation = validatePoConfig({
    prefix: input.prefix ?? current.prefix,
    padding: input.padding ?? current.padding,
    nextNumber: input.nextValue ?? current.next_value,
  });
  if (!validation.ok) throw new PurchasingError('validation_failed', 'invalid PO configuration', validation.errors);

  const nextValue = input.nextValue ?? Number(current.next_value);
  if (nextValue < Number(current.next_value)) {
    throw new PurchasingError('sequence_rewind', 'a PO sequence can only move forward — issued numbers are permanent');
  }

  await ctx.reference.updatePoConfig(
    actor.orgId,
    {
      prefix: input.prefix ?? current.prefix,
      padding: input.padding ?? current.padding,
      suffix: input.suffix ?? current.suffix,
      nextValue,
    },
    actor.id,
    ctx.clock.now(),
  );

  await emit(ctx, actor, actor.orgId, [
    events.poConfigChanged(
      { prefix: current.prefix, padding: current.padding, suffix: current.suffix, nextValue: current.next_value },
      { prefix: input.prefix ?? current.prefix, padding: input.padding ?? current.padding, nextValue },
    ),
  ]);
  return { ok: true };
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
  name?: string; accountNumber?: string; phone?: string; address?: string; notes?: string;
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

  const now = ctx.clock.now();
  const vendorId = await ctx.uow.run(async () => {
    const id = await ctx.reference.createVendor(actor.orgId, v, actor.id, now);
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

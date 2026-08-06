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
import { ROLES } from '../domain/roles.mjs';

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

/** Assign or unassign a foreman to a job site. */
export async function setJobAssignment(
  ctx: PurchasingContext, actor: Actor, userId: string, jobNumber: string, assigned: boolean,
) {
  await must(ctx, actor, 'admin.assignments');
  const target = await ctx.identity.load(userId);
  if (!target || target.orgId !== actor.orgId) throw new PurchasingError('not_found', 'user not found');
  if (!jobNumber?.trim()) throw new PurchasingError('validation_failed', 'a job number is required');

  if (assigned) await ctx.identity.assignJob(userId, jobNumber.trim(), actor.id, ctx.clock.now());
  else await ctx.identity.unassignJob(userId, jobNumber.trim());

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

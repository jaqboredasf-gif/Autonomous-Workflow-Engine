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

export function poConfig(ctx: PurchasingContext, actor: Actor) {
  return ctx.reference.poConfig(actor.orgId);
}

/**
 * Change the PO numbering scheme. The next value may only move FORWARD:
 * winding a sequence backwards would re-issue numbers that vendors and invoices
 * already reference.
 */
export function updatePoConfig(
  ctx: PurchasingContext, actor: Actor,
  input: { prefix?: string; padding?: number; suffix?: string; nextValue?: number },
) {
  must(ctx, actor, 'admin.po_config');
  const current = ctx.reference.poConfig(actor.orgId);

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

  ctx.reference.updatePoConfig(
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

  emit(ctx, actor, actor.orgId, [
    events.poConfigChanged(
      { prefix: current.prefix, padding: current.padding, suffix: current.suffix, nextValue: current.next_value },
      { prefix: input.prefix ?? current.prefix, padding: input.padding ?? current.padding, nextValue },
    ),
  ]);
  return { ok: true };
}

/** Grant or revoke purchasing approval authority for a user in this org. */
export function setApprovalAuthority(ctx: PurchasingContext, actor: Actor, userId: string, canApprove: boolean) {
  must(ctx, actor, 'admin.users');
  const target = ctx.identity.load(userId);
  if (!target || target.orgId !== actor.orgId) throw new PurchasingError('not_found', 'user not found');

  ctx.reference.setApprovalAuthority(userId, canApprove, actor.id, ctx.clock.now());
  emit(ctx, actor, actor.orgId, [
    events.approvalAuthorityChanged(
      userId, { canApprove: target.canApprove }, { canApprove },
      `approval authority ${canApprove ? 'granted to' : 'revoked from'} ${target.name}`,
    ),
  ]);
  return { ok: true };
}

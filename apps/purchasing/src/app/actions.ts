'use server';
/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// actions.ts — the ONLY way the browser reaches the database.
//
// Every action here reads the actor from the server-side session cookie and
// hands it to src/server/service.ts, which authorizes, guards the transition,
// writes and audits. None of these functions trust anything in the form payload
// about WHO is acting, and none of them take a role, a permission or an org id
// from the client.
//
// Errors come back as {error} rather than thrown, so a refusal renders as a
// message the human can act on instead of a stack trace.
// ---------------------------------------------------------------------------

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import * as S from '../server/service.ts';
import { saveReviewAndDecide } from '../purchasing/application/decisions.ts';
import * as admin from '../purchasing/application/administration.ts';
import { currentActor, purchasingRequestContext } from '../server/session.ts';

type Result = { ok: true; data?: any } | { ok: false; error: string; reason?: string; details?: any };

async function run<T>(fn: (ctx: any, actor: S.Actor) => T): Promise<Result> {
  const actor = await currentActor();
  if (!actor) return { ok: false, error: 'You are signed out. Sign in again.', reason: 'no_session' };
  try {
    const data = fn(purchasingRequestContext(), actor);
    return { ok: true, data };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.message ?? 'Something went wrong.',
      reason: err?.reason,
      details: err?.details ?? null,
    };
  }
}

// --- session ---------------------------------------------------------------

// Sign-in and sign-out now live in auth-actions.ts: they are the only actions
// callable without a session, and keeping them apart makes that visible.

// --- requests --------------------------------------------------------------

export async function createRequestAction(_prev: unknown, formData: FormData): Promise<Result> {
  const items = parseItems(formData);
  const result = await run((ctx, actor) =>
    S.createRequest(ctx, actor, {
      jobNumber: String(formData.get('jobNumber') ?? ''),
      needByDate: String(formData.get('needByDate') ?? ''),
      needByTime: String(formData.get('needByTime') ?? ''),
      deliveryLocationId: String(formData.get('deliveryLocationId') ?? ''),
      deliveryMethod: String(formData.get('deliveryMethod') ?? 'DELIVERY'),
      reason: String(formData.get('reason') ?? ''),
      notes: String(formData.get('notes') ?? ''),
      items,
    }),
  );
  if (!result.ok) return result;

  const submit = String(formData.get('submit') ?? '') === 'now';
  if (submit) {
    const submitted = await run((ctx, actor) => S.submitRequest(ctx, actor, result.data.id));
    if (!submitted.ok) return submitted;
  }
  revalidatePath('/');
  redirect(`/requests/${result.data.id}`);
}

function parseItems(formData: FormData) {
  const descriptions = formData.getAll('itemDescription').map(String);
  const quantities = formData.getAll('itemQty').map(String);
  const units = formData.getAll('itemUnit').map(String);
  const stockNumbers = formData.getAll('itemStockNumber').map(String);
  const notes = formData.getAll('itemNotes').map(String);
  return descriptions
    .map((description, i) => ({
      description,
      qty: quantities[i] ?? '',
      unit: units[i] ?? 'ea',
      stockNumber: stockNumbers[i] || undefined,
      notes: notes[i] || undefined,
    }))
    .filter((item) => item.description.trim() !== '' || item.qty.trim() !== '');
}

export async function submitRequestAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  await run((ctx, actor) => S.submitRequest(ctx, actor, id));
  revalidatePath(`/requests/${id}`);
}

export async function cancelRequestAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  await run((ctx, actor) => S.cancelRequest(ctx, actor, id, String(formData.get('reason') ?? '')));
  revalidatePath(`/requests/${id}`);
}

export async function addNoteAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  await run((ctx, actor) => S.addNote(ctx, actor, id, String(formData.get('note') ?? '')));
  revalidatePath(`/requests/${id}`);
}

export async function answerClarificationAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  await run((ctx, actor) => S.answerClarification(ctx, actor, id, String(formData.get('answer') ?? '')));
  revalidatePath(`/requests/${id}`);
}

// --- workshop review + decision --------------------------------------------

export async function saveReviewAction(_prev: unknown, formData: FormData): Promise<Result> {
  const id = String(formData.get('requestId'));
  const lines = parseReviewLines(formData);
  const result = await run((ctx, actor) =>
    S.saveReview(ctx, actor, id, { workshopNotes: String(formData.get('workshopNotes') ?? ''), lines }),
  );
  if (result.ok) revalidatePath(`/requests/${id}/review`);
  return result;
}

function parseReviewLines(formData: FormData) {
  const ids = formData.getAll('lineRequestItemId').map(String);
  const stock = formData.getAll('lineUsableStock').map(String);
  const approved = formData.getAll('lineApprovedQty').map(String);
  const finalQty = formData.getAll('lineFinalOrderQty').map(String);
  const vendor = formData.getAll('lineVendorId').map(String);
  const cost = formData.getAll('lineUnitCost').map(String);
  const substitute = formData.getAll('lineSubstitute').map(String);
  const arrival = formData.getAll('lineExpectedArrival').map(String);
  const notes = formData.getAll('lineNotes').map(String);
  const override = formData.getAll('lineOverrideReason').map(String);
  return ids.map((requestItemId, i) => ({
    requestItemId,
    usableStock: stock[i] ?? '0',
    approvedQty: approved[i] ?? '',
    finalOrderQty: finalQty[i] ?? '',
    vendorId: vendor[i] || null,
    estimatedUnitCost: cost[i] || null,
    substituteDescription: substitute[i] || null,
    expectedArrivalDate: arrival[i] || null,
    lineNotes: notes[i] || null,
    overrideReason: override[i] || null,
  }));
}

/**
 * Save the workshop's numbers and, if the approver pressed a decision button,
 * decide — in that order, in one request. The decision must refer to saved
 * numbers, so "approve" can never be recorded against values still sitting in a
 * browser form.
 */
export async function reviewAndDecideAction(_prev: unknown, formData: FormData): Promise<Result> {
  const requestId = String(formData.get('requestId'));
  const intent = String(formData.get('intent') ?? 'save');

  // Save-then-decide is ONE use case (the decision must refer to saved
  // numbers), so this action only unpacks the form and calls it.
  const result = await run((ctx, actor) =>
    saveReviewAndDecide(
      ctx,
      actor,
      requestId,
      { workshopNotes: String(formData.get('workshopNotes') ?? ''), lines: parseReviewLines(formData) },
      intent === 'save' ? 'SAVE' : (intent as 'APPROVE' | 'REJECT' | 'CLARIFY'),
      {
        notes: String(formData.get('notes') ?? ''),
        reason: String(formData.get('reason') ?? ''),
        question: String(formData.get('question') ?? ''),
      },
    ),
  );
  if (!result.ok) return result;

  revalidatePath(`/requests/${requestId}/review`);
  revalidatePath('/queue');
  if (intent === 'save') return result;
  redirect(`/requests/${requestId}`);
}

export async function decideAction(_prev: unknown, formData: FormData): Promise<Result> {
  const id = String(formData.get('requestId'));
  const decision = String(formData.get('decision')) as 'APPROVE' | 'REJECT' | 'CLARIFY';
  const result = await run((ctx, actor) =>
    S.decide(ctx, actor, id, decision, {
      notes: String(formData.get('notes') ?? ''),
      reason: String(formData.get('reason') ?? ''),
      question: String(formData.get('question') ?? ''),
    }),
  );
  if (result.ok) {
    revalidatePath(`/requests/${id}`);
    revalidatePath('/queue');
  }
  return result;
}

// --- purchase order + email -------------------------------------------------

export async function generatePoAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  const result = await run((ctx, actor) => S.generatePurchaseOrder(ctx, actor, id));
  revalidatePath(`/requests/${id}`);
  if (result.ok) redirect(`/requests/${id}/po`);
}

export async function generateEmailDraftAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  const result = await run((ctx, actor) => S.generateVendorEmailDraft(ctx, actor, id));
  revalidatePath(`/requests/${id}`);
  if (result.ok) redirect(`/requests/${id}/email`);
}

export async function updateEmailDraftAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  await run((ctx, actor) =>
    S.updateEmailDraft(ctx, actor, String(formData.get('draftId')), {
      subject: String(formData.get('subject') ?? ''),
      body: String(formData.get('body') ?? ''),
    }),
  );
  revalidatePath(`/requests/${id}/email`);
}

export async function advanceEmailDraftAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  await run((ctx, actor) =>
    S.advanceEmailDraft(ctx, actor, String(formData.get('draftId')), String(formData.get('to')) as any),
  );
  revalidatePath(`/requests/${id}/email`);
}

// --- ordering, tracking, receiving, completion ------------------------------

export async function markOrderedAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  await run((ctx, actor) => S.markOrdered(ctx, actor, id, { notes: String(formData.get('notes') ?? '') }));
  revalidatePath(`/requests/${id}`);
}

export async function updateTrackingAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  await run((ctx, actor) =>
    S.updateTracking(ctx, actor, id, {
      trackingNumber: String(formData.get('trackingNumber') ?? ''),
      carrier: String(formData.get('carrier') ?? ''),
      expectedArrivalDate: String(formData.get('expectedArrivalDate') ?? ''),
    }),
  );
  revalidatePath(`/requests/${id}`);
}

export async function recordReceiptAction(_prev: unknown, formData: FormData): Promise<Result> {
  const id = String(formData.get('requestId'));
  const poItemIds = formData.getAll('receiptPoItemId').map(String);
  const received = formData.getAll('receiptReceivedQty').map(String);
  const damaged = formData.getAll('receiptDamagedQty').map(String);
  const backordered = formData.getAll('receiptBackorderedQty').map(String);
  const writtenOff = formData.getAll('receiptWrittenOffQty').map(String);
  const overrides = formData.getAll('receiptOverrideReason').map(String);
  const notes = formData.getAll('receiptLineNotes').map(String);

  const result = await run((ctx, actor) =>
    S.recordReceipt(ctx, actor, id, {
      receivedDate: String(formData.get('receivedDate') ?? ''),
      packingSlipNumber: String(formData.get('packingSlipNumber') ?? ''),
      notes: String(formData.get('receiptNotes') ?? ''),
      lines: poItemIds.map((purchaseOrderItemId, i) => ({
        purchaseOrderItemId,
        receivedQty: received[i] ?? '',
        damagedQty: damaged[i] ?? '',
        backorderedQty: backordered[i] ?? '',
        writtenOffQty: writtenOff[i] ?? '',
        overrideReason: overrides[i] || null,
        notes: notes[i] || null,
      })),
    }),
  );
  if (result.ok) revalidatePath(`/requests/${id}`);
  return result;
}

// --- administration ---------------------------------------------------------

/** Some administrative use cases talk to the auth provider, so they await. */
async function runAsync(fn: (ctx: any, actor: S.Actor) => Promise<any>): Promise<Result> {
  const actor = await currentActor();
  if (!actor) return { ok: false, error: 'You are signed out. Sign in again.', reason: 'no_session' };
  try {
    return { ok: true, data: await fn(purchasingRequestContext(), actor) };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? 'Something went wrong.', reason: err?.reason, details: err?.details ?? null };
  }
}

export async function inviteUserAction(_prev: unknown, formData: FormData): Promise<Result> {
  const result = await runAsync((ctx, actor) =>
    admin.inviteUser(ctx, actor, {
      fullName: String(formData.get('fullName') ?? ''),
      email: String(formData.get('email') ?? ''),
      roles: formData.getAll('roles').map(String),
      temporaryPassword: String(formData.get('temporaryPassword') ?? ''),
      canApprove: formData.get('canApprove') === 'on',
      isDeliveryReceiver: formData.get('isDeliveryReceiver') === 'on',
      jobNumbers: String(formData.get('jobNumbers') ?? '').split(',').map((j) => j.trim()).filter(Boolean),
    }),
  );
  if (result.ok) revalidatePath('/admin');
  return result;
}

export async function setUserDisabledAction(formData: FormData) {
  await runAsync((ctx, actor) =>
    admin.setUserDisabled(ctx, actor, String(formData.get('userId')), String(formData.get('disabled')) === 'true'),
  );
  revalidatePath('/admin');
}

export async function resetUserAccessAction(_prev: unknown, formData: FormData): Promise<Result> {
  const result = await runAsync((ctx, actor) =>
    admin.resetUserAccess(ctx, actor, String(formData.get('userId')), String(formData.get('temporaryPassword') ?? '')),
  );
  if (result.ok) revalidatePath('/admin');
  return result;
}

export async function setUserRolesAction(formData: FormData) {
  await run((ctx, actor) =>
    admin.setUserRoles(ctx, actor, String(formData.get('userId')), formData.getAll('roles').map(String)),
  );
  revalidatePath('/admin');
}

export async function setJobAssignmentAction(formData: FormData) {
  await run((ctx, actor) =>
    admin.setJobAssignment(
      ctx, actor, String(formData.get('userId')), String(formData.get('jobNumber') ?? ''),
      String(formData.get('assigned')) === 'true',
    ),
  );
  revalidatePath('/admin');
}

export async function setDeliveryReceiverAction(formData: FormData) {
  await run((ctx, actor) =>
    admin.setDeliveryReceiver(ctx, actor, String(formData.get('userId')), String(formData.get('isReceiver')) === 'true'),
  );
  revalidatePath('/admin');
}

export async function updatePoConfigAction(formData: FormData) {
  await run((ctx, actor) =>
    S.updatePoConfig(ctx, actor, {
      prefix: String(formData.get('prefix') ?? ''),
      padding: Number(formData.get('padding') ?? 5),
      suffix: String(formData.get('suffix') ?? ''),
      nextValue: Number(formData.get('nextValue') ?? 0),
    }),
  );
  revalidatePath('/admin');
}

export async function setApprovalAuthorityAction(formData: FormData) {
  await run((ctx, actor) =>
    S.setApprovalAuthority(ctx, actor, String(formData.get('userId')), String(formData.get('canApprove')) === 'true'),
  );
  revalidatePath('/admin');
}

export async function completeRequestAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  await run((ctx, actor) => S.completeRequest(ctx, actor, id, String(formData.get('notes') ?? '')));
  revalidatePath(`/requests/${id}`);
}

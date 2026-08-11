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
import * as fulfilment from '../purchasing/application/fulfilment.ts';
import * as requests from '../purchasing/application/requests.ts';
import { currentActor, purchasingRequestContext } from '../server/session.ts';

type Result = { ok: true; data?: any } | { ok: false; error: string; reason?: string; details?: any };

async function run<T>(fn: (ctx: any, actor: S.Actor) => Promise<T> | T): Promise<Result> {
  const actor = await currentActor();
  if (!actor) return { ok: false, error: 'You are signed out. Sign in again.', reason: 'no_session' };
  try {
    const data = await fn(await purchasingRequestContext(), actor);
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
  const result = await run(async (ctx, actor) =>
    await S.createRequest(ctx, actor, {
      jobNumber: String(formData.get('jobNumber') ?? ''),
      needByDate: String(formData.get('needByDate') ?? ''),
      needByTime: String(formData.get('needByTime') ?? ''),
      deliveryLocationId: String(formData.get('deliveryLocationId') ?? ''),
      deliveryMethod: String(formData.get('deliveryMethod') ?? 'DELIVERY'),
      reason: String(formData.get('reason') ?? ''),
      notes: withVendorSuggestion(formData),
      items,
    }),
  );
  if (!result.ok) return result;

  // Attachments need the request to exist first, so they follow the create.
  // A file that fails to store must NOT lose the request the person just
  // typed: the failure is reported on the request they now have, not by
  // throwing away their work.
  const files = await readFiles(formData, 'attachments');
  for (const file of files) {
    await run(async (ctx, actor) => await requests.attachFile(ctx, actor, result.data.id, file));
  }

  const submit = String(formData.get('submit') ?? '') === 'now';
  if (submit) {
    const submitted = await run(async (ctx, actor) => await S.submitRequest(ctx, actor, result.data.id));
    if (!submitted.ok) return submitted;
  }
  revalidatePath('/');
  redirect(`/requests/${result.data.id}`);
}

/**
 * The requester's vendor SUGGESTION, folded into the request's notes and
 * attributed as a suggestion.
 *
 * It does not go anywhere near `vendor_id`. That column is in
 * REQUESTOR_FORBIDDEN_FIELDS (domain/roles.mjs) because choosing the supplier
 * is a purchasing decision, and validation would reject it — correctly. What
 * the field is FOR is the knowledge the field has and the office does not
 * ("we always get this from Graybar on Route 9"), and prose is the honest
 * place for that.
 */
function withVendorSuggestion(formData: FormData): string {
  const notes = String(formData.get('notes') ?? '').trim();
  const vendor = String(formData.get('preferredVendor') ?? '').trim();
  if (!vendor) return notes;
  const line = `Requester suggests vendor: ${vendor}`;
  return notes ? `${notes}\n\n${line}` : line;
}

/**
 * Files out of a multipart form, as the attachment port wants them.
 *
 * Bounded on both axes: inline storage puts the bytes in the database, so an
 * unbounded upload is an unbounded row. Anything over the limit is dropped
 * rather than truncated — half a photograph is not evidence.
 */
const MAX_FILES = 6;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

async function readFiles(formData: FormData, field: string) {
  const entries = formData.getAll(field).filter((f): f is File => f instanceof File && f.size > 0);
  const out: Array<{ filename: string; contentType: string; dataBase64: string; byteSize: number }> = [];
  for (const file of entries.slice(0, MAX_FILES)) {
    if (file.size > MAX_FILE_BYTES) continue;
    const bytes = Buffer.from(await file.arrayBuffer());
    out.push({
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      dataBase64: bytes.toString('base64'),
      byteSize: bytes.byteLength,
    });
  }
  return out;
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
  await run(async (ctx, actor) => await S.submitRequest(ctx, actor, id));
  revalidatePath(`/requests/${id}`);
}

export async function cancelRequestAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  await run(async (ctx, actor) => await S.cancelRequest(ctx, actor, id, String(formData.get('reason') ?? '')));
  revalidatePath(`/requests/${id}`);
}

export async function addNoteAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  await run(async (ctx, actor) => await S.addNote(ctx, actor, id, String(formData.get('note') ?? '')));
  revalidatePath(`/requests/${id}`);
}

export async function answerClarificationAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  await run(async (ctx, actor) => await S.answerClarification(ctx, actor, id, String(formData.get('answer') ?? '')));
  revalidatePath(`/requests/${id}`);
}

// --- workshop review + decision --------------------------------------------

export async function saveReviewAction(_prev: unknown, formData: FormData): Promise<Result> {
  const id = String(formData.get('requestId'));
  const lines = parseReviewLines(formData);
  const result = await run(async (ctx, actor) =>
    await S.saveReview(ctx, actor, id, { workshopNotes: String(formData.get('workshopNotes') ?? ''), lines }),
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
  const result = await run(async (ctx, actor) =>
    await saveReviewAndDecide(
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

/**
 * THE PURCHASER'S ONE BUTTON: record the stock check, approve, produce the PO,
 * and land on the printable sheet.
 *
 * Everything it does was already possible; it took three screens. The
 * composition lives in the application layer (reviewApproveAndCreatePo), not
 * here — this only unpacks the form and decides where the person ends up,
 * which is the printable purchase order, because that is what he came for.
 */
export async function approveAndCreatePoAction(_prev: unknown, formData: FormData): Promise<Result> {
  const requestId = String(formData.get('requestId'));
  const result = await run(async (ctx, actor) =>
    await S.reviewApproveAndCreatePo(
      ctx,
      actor,
      requestId,
      { workshopNotes: String(formData.get('workshopNotes') ?? ''), lines: parseReviewLines(formData) },
      { notes: String(formData.get('notes') ?? '') },
    ),
  );
  if (!result.ok) return result;

  revalidatePath(`/requests/${requestId}`);
  revalidatePath('/dashboard');
  revalidatePath('/workshop');
  redirect(`/requests/${requestId}/po?printed=1`);
}

export async function decideAction(_prev: unknown, formData: FormData): Promise<Result> {
  const id = String(formData.get('requestId'));
  const decision = String(formData.get('decision')) as 'APPROVE' | 'REJECT' | 'CLARIFY';
  const result = await run(async (ctx, actor) =>
    await S.decide(ctx, actor, id, decision, {
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
  const result = await run(async (ctx, actor) => await S.generatePurchaseOrder(ctx, actor, id));
  revalidatePath(`/requests/${id}`);
  if (result.ok) redirect(`/requests/${id}/po`);
}

export async function generateEmailDraftAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  const result = await run(async (ctx, actor) => await S.generateVendorEmailDraft(ctx, actor, id));
  revalidatePath(`/requests/${id}`);
  if (result.ok) redirect(`/requests/${id}/email`);
}

export async function updateEmailDraftAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  await run(async (ctx, actor) =>
    await S.updateEmailDraft(ctx, actor, String(formData.get('draftId')), {
      subject: String(formData.get('subject') ?? ''),
      body: String(formData.get('body') ?? ''),
    }),
  );
  revalidatePath(`/requests/${id}/email`);
}

export async function advanceEmailDraftAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  await run(async (ctx, actor) =>
    await S.advanceEmailDraft(ctx, actor, String(formData.get('draftId')), String(formData.get('to')) as any),
  );
  revalidatePath(`/requests/${id}/email`);
}

// --- ordering, tracking, receiving, completion ------------------------------

export async function markOrderedAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  await run(async (ctx, actor) => await S.markOrdered(ctx, actor, id, { notes: String(formData.get('notes') ?? '') }));
  revalidatePath(`/requests/${id}`);
}

export async function updateTrackingAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  await run(async (ctx, actor) =>
    await S.updateTracking(ctx, actor, id, {
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

  // Evidence travels WITH the receipt, in the same call, so a photograph
  // cannot end up attached to a receipt that was refused — or a receipt end up
  // recorded without the photograph somebody took to justify it.
  const evidence = [
    ...(await readFiles(formData, 'receiptPhotos')),
    ...(await readFiles(formData, 'receiptDocuments')),
  ];

  const result = await run(async (ctx, actor) =>
    await S.recordReceipt(ctx, actor, id, {
      receivedDate: String(formData.get('receivedDate') ?? ''),
      packingSlipNumber: String(formData.get('packingSlipNumber') ?? ''),
      notes: String(formData.get('receiptNotes') ?? ''),
      attachments: evidence,
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

// run() awaits its callback, so there is one helper rather than a sync and an
// async variant that could drift.
const runAsync = run;

export async function inviteUserAction(_prev: unknown, formData: FormData): Promise<Result> {
  const result = await runAsync(async (ctx, actor) =>
    await admin.inviteUser(ctx, actor, {
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
  await runAsync(async (ctx, actor) =>
    await admin.setUserDisabled(ctx, actor, String(formData.get('userId')), String(formData.get('disabled')) === 'true'),
  );
  revalidatePath('/admin');
}

export async function resetUserAccessAction(_prev: unknown, formData: FormData): Promise<Result> {
  const result = await runAsync(async (ctx, actor) =>
    await admin.resetUserAccess(ctx, actor, String(formData.get('userId')), String(formData.get('temporaryPassword') ?? '')),
  );
  if (result.ok) revalidatePath('/admin');
  return result;
}

export async function setUserRolesAction(formData: FormData) {
  await run(async (ctx, actor) =>
    await admin.setUserRoles(ctx, actor, String(formData.get('userId')), formData.getAll('roles').map(String)),
  );
  revalidatePath('/admin');
}

export async function setJobAssignmentAction(formData: FormData) {
  await run(async (ctx, actor) =>
    await admin.setJobAssignment(
      ctx, actor, String(formData.get('userId')), String(formData.get('jobNumber') ?? ''),
      String(formData.get('assigned')) === 'true',
    ),
  );
  revalidatePath('/admin');
}

export async function setDeliveryReceiverAction(formData: FormData) {
  await run(async (ctx, actor) =>
    await admin.setDeliveryReceiver(ctx, actor, String(formData.get('userId')), String(formData.get('isReceiver')) === 'true'),
  );
  revalidatePath('/admin');
}

export async function updatePoConfigAction(formData: FormData) {
  await run(async (ctx, actor) =>
    await S.updatePoConfig(ctx, actor, {
      prefix: String(formData.get('prefix') ?? ''),
      padding: Number(formData.get('padding') ?? 5),
      suffix: String(formData.get('suffix') ?? ''),
      nextValue: Number(formData.get('nextValue') ?? 0),
    }),
  );
  revalidatePath('/admin');
}

export async function setApprovalAuthorityAction(formData: FormData) {
  await run(async (ctx, actor) =>
    await S.setApprovalAuthority(ctx, actor, String(formData.get('userId')), String(formData.get('canApprove')) === 'true'),
  );
  revalidatePath('/admin');
}

export async function completeRequestAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  await run(async (ctx, actor) => await S.completeRequest(ctx, actor, id, String(formData.get('notes') ?? '')));
  revalidatePath(`/requests/${id}`);
}

// --- directories: vendors and jobs -------------------------------------------
// The two things an organization must be able to configure before it can place
// an order. Previously read-only lists, which meant a new customer needed a
// developer to insert rows.

export async function createVendorAction(_prev: unknown, formData: FormData): Promise<Result> {
  const result = await runAsync(async (ctx, actor) =>
    await admin.createVendor(ctx, actor, {
      name: String(formData.get('name') ?? ''),
      accountNumber: String(formData.get('accountNumber') ?? ''),
      phone: String(formData.get('phone') ?? ''),
      address: String(formData.get('address') ?? ''),
      notes: String(formData.get('notes') ?? ''),
      contactName: String(formData.get('contactName') ?? ''),
      contactEmail: String(formData.get('contactEmail') ?? ''),
      contactPhone: String(formData.get('contactPhone') ?? ''),
    }),
  );
  if (result.ok) revalidatePath('/admin');
  return result;
}

export async function updateVendorAction(_prev: unknown, formData: FormData): Promise<Result> {
  const result = await runAsync(async (ctx, actor) =>
    await admin.updateVendor(ctx, actor, String(formData.get('vendorId')), {
      name: String(formData.get('name') ?? ''),
      accountNumber: String(formData.get('accountNumber') ?? ''),
      phone: String(formData.get('phone') ?? ''),
      address: String(formData.get('address') ?? ''),
      contactName: String(formData.get('contactName') ?? ''),
      contactEmail: String(formData.get('contactEmail') ?? ''),
      contactPhone: String(formData.get('contactPhone') ?? ''),
    }),
  );
  if (result.ok) revalidatePath('/admin');
  return result;
}

export async function setVendorActiveAction(formData: FormData) {
  await runAsync(async (ctx, actor) =>
    await admin.setVendorActive(ctx, actor, String(formData.get('vendorId')),
      String(formData.get('isActive')) === 'true'),
  );
  revalidatePath('/admin');
}

export async function createJobAction(_prev: unknown, formData: FormData): Promise<Result> {
  const result = await runAsync(async (ctx, actor) =>
    await admin.createJob(ctx, actor, {
      jobNumber: String(formData.get('jobNumber') ?? ''),
      name: String(formData.get('name') ?? ''),
      customer: String(formData.get('customer') ?? ''),
      siteAddress: String(formData.get('siteAddress') ?? ''),
      deliveryInstructions: String(formData.get('deliveryInstructions') ?? ''),
      costCode: String(formData.get('costCode') ?? ''),
    }),
  );
  if (result.ok) revalidatePath('/admin');
  return result;
}

export async function updateJobAction(_prev: unknown, formData: FormData): Promise<Result> {
  const result = await runAsync(async (ctx, actor) =>
    await admin.updateJob(ctx, actor, String(formData.get('jobId')), {
      name: String(formData.get('name') ?? ''),
      customer: String(formData.get('customer') ?? ''),
      siteAddress: String(formData.get('siteAddress') ?? ''),
      deliveryInstructions: String(formData.get('deliveryInstructions') ?? ''),
      status: String(formData.get('status') ?? 'ACTIVE'),
    }),
  );
  if (result.ok) revalidatePath('/admin');
  return result;
}

/**
 * Record what was actually paid. Deliberately separate from every purchasing
 * action: it arrives later, from accounting, and never blocks ordering or
 * receiving. An empty value clears the figure back to unknown.
 */
export async function recordActualCostAction(_prev: unknown, formData: FormData): Promise<Result> {
  const result = await runAsync(async (ctx, actor) =>
    await fulfilment.recordActualCost(ctx, actor, String(formData.get('requestId')), {
      actualTotal: String(formData.get('actualTotal') ?? ''),
      reference: String(formData.get('reference') ?? ''),
      source: String(formData.get('source') ?? ''),
    }),
  );
  if (result.ok) {
    revalidatePath('/accounting');
    revalidatePath(`/requests/${String(formData.get('requestId'))}`);
  }
  return result;
}

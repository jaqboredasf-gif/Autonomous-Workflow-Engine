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
import { currentActor, mustChangePassword, purchasingRequestContext } from '../server/session.ts';
import { safeFilename } from '../server/file-response.ts';

type Result = { ok: true; data?: any } | { ok: false; error: string; reason?: string; details?: any };

async function run<T>(fn: (ctx: any, actor: S.Actor) => Promise<T> | T): Promise<Result> {
  const actor = await currentActor();
  if (!actor) return { ok: false, error: 'You are signed out. Sign in again.', reason: 'no_session' };
  // ONE SENTENCE COVERING EVERY ACTION IN THIS FILE.
  //
  // Route guards protect pages; this protects the writes. A person signed in on
  // a password an administrator chose could otherwise still POST to any action
  // here — the screen would be unreachable, the operation would not be, and the
  // form of the attack is a saved bookmark, not a clever one. The change
  // screen's own action lives in auth-actions.ts and does not pass through here.
  if (mustChangePassword(actor)) {
    return {
      ok: false,
      error: 'Choose your own password before using PCC.',
      reason: 'must_change_password',
    };
  }
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


// ---------------------------------------------------------------------------
// SAYING WHETHER IT WORKED.
//
// THE DEFECT THIS CLOSES. Seven actions on the request screen — submit, mark
// ordered, complete, cancel, add note, answer a clarification, save tracking —
// called run(), THREW THE RESULT AWAY and revalidated the page. On success that
// is merely mute. On failure it is worse than mute: the refusal is computed,
// the reason is known, and the user is shown the same page with nothing
// changed and nothing said. Pressing "Complete request" on an order with a
// line outstanding looked exactly like pressing a dead button.
//
// These are plain <form action={…}> submissions, not useActionState, so there
// is no state to render into. The outcome therefore travels the way a
// no-JavaScript browser can carry it: in the URL, on a redirect the page
// reads once and the next navigation drops.
//
// The wording lives in ./outcomes.ts rather than here: a `'use server'` module
// may export async functions and NOTHING else, and exporting a table from this
// file compiles and typechecks and then fails the production build.
// ---------------------------------------------------------------------------

/**
 * Finish a plain form action by telling the user what happened.
 *
 * On success: `?done=<key>`. On failure: `?failed=<key>` carrying the domain's
 * own message, which is written for a person ("3 line(s) are not fully
 * resolved") rather than for a log.
 */
function outcome(path: string, key: string, result: Result): never {
  const params = result.ok
    ? `done=${encodeURIComponent(key)}`
    : `failed=${encodeURIComponent(key)}&why=${encodeURIComponent(result.error)}`;
  redirect(`${path}${path.includes('?') ? '&' : '?'}${params}`);
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
      // The name comes from whatever chose it — a phone, a scanner, or a person
      // typing. It is stored, returned in a download header, and (on the
      // Supabase provider) CONCATENATED INTO A STORAGE KEY as
      // `<org>/requests/<id>/<filename>`, where a `../` would put one company's
      // photograph outside its own prefix. Cleaned once, here, at the only door
      // files come through, so no store has to remember to distrust it.
      filename: safeFilename(file.name, 'attachment'),
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
  const result = await run(async (ctx, actor) => await S.submitRequest(ctx, actor, id));
  revalidatePath(`/requests/${id}`);
  outcome(`/requests/${id}`, 'submitted', result);
}

export async function cancelRequestAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  const result = await run(async (ctx, actor) => await S.cancelRequest(ctx, actor, id, String(formData.get('reason') ?? '')));
  revalidatePath(`/requests/${id}`);
  outcome(`/requests/${id}`, 'cancelled', result);
}

export async function addNoteAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  const result = await run(async (ctx, actor) => await S.addNote(ctx, actor, id, String(formData.get('note') ?? '')));
  revalidatePath(`/requests/${id}`);
  outcome(`/requests/${id}`, 'noted', result);
}

export async function answerClarificationAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  const result = await run(async (ctx, actor) => await S.answerClarification(ctx, actor, id, String(formData.get('answer') ?? '')));
  revalidatePath(`/requests/${id}`);
  outcome(`/requests/${id}`, 'answered', result);
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
  // ONE SUPPLIER FOR THE REQUEST, sent as one field.
  //
  // The screens post it both ways: a named <select> that works without
  // JavaScript, and a hidden per-line copy that React keeps in step. This
  // prefers the request-level field and falls back to the positional one, so
  // neither an unhydrated page nor an older cached form loses the vendor the
  // purchaser chose.
  const requestVendorId = String(formData.get('vendorId') ?? '').trim();
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
    vendorId: requestVendorId || vendor[i] || null,
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

/**
 * "I placed it." One press, and back to the board.
 *
 * There is no confirmation step. Marking an order placed is something the
 * purchaser does several times a day, it is not destructive, and the record
 * already says who did it and when — so a dialog asking whether he meant it
 * buys nothing and costs a click every time.
 *
 * ON SUCCESS HE GOES TO THE DASHBOARD, not back to the request he has just
 * finished with. The order is placed; the next thing he wants is the next
 * thing to do. Failures stay on the request, where the problem is.
 */
export async function markOrderedAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  const result = await run(async (ctx, actor) => await S.markOrdered(ctx, actor, id, { notes: String(formData.get('notes') ?? '') }));
  revalidatePath(`/requests/${id}`);
  revalidatePath('/dashboard');
  if (!result.ok) outcome(`/requests/${id}`, 'ordered', result);
  outcome('/dashboard', 'ordered', result);
}

export async function updateTrackingAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  const result = await run(async (ctx, actor) =>
    await S.updateTracking(ctx, actor, id, {
      trackingNumber: String(formData.get('trackingNumber') ?? ''),
      carrier: String(formData.get('carrier') ?? ''),
      expectedArrivalDate: String(formData.get('expectedArrivalDate') ?? ''),
    }),
  );
  revalidatePath(`/requests/${id}`);
  outcome(`/requests/${id}`, 'tracking', result);
}

/**
 * "It arrived." One click, from the receiving queue or the request itself.
 *
 * Receives every outstanding quantity and closes the purchase if this person is
 * allowed to. No form, because there is nothing to ask: PCC produced the
 * purchase order and already knows what was on it. The physical paperwork is
 * the vendor's receipt stapled to the printed PO, which is where Lippolis
 * keeps it.
 */
export async function markReceivedAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  const result = await run(async (ctx, actor) => await S.receiveEverything(ctx, actor, id));
  revalidatePath('/receiving');
  revalidatePath(`/requests/${id}`);
  outcome(`/requests/${id}`, 'received', result);
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

/**
 * Line one job-and-vendor pair up with the office's paper book.
 *
 * There is no global numbering to configure — a purchase order is
 * job + vendor + sequence and every pair counts from 1 — so this is the only
 * numbering write an administrator has, and it is needed only where paper
 * purchase orders already exist for that pair.
 *
 * The refusals (backwards, or below what PCC has already issued) must be
 * VISIBLE: an administrator who saw the same screen with the old number in it
 * could not tell whether the save had failed or whether they had mistyped.
 */
export async function initializePoSequenceAction(formData: FormData) {
  const result = await run(async (ctx, actor) =>
    await S.initializePoSequence(ctx, actor, {
      jobNumber: String(formData.get('jobNumber') ?? ''),
      vendorId: String(formData.get('vendorId') ?? ''),
      lastIssuedSequence: String(formData.get('lastIssuedSequence') ?? ''),
      nextSequence: String(formData.get('nextSequence') ?? ''),
      acknowledgeIssued: String(formData.get('acknowledgeIssued') ?? '') === 'true',
    }),
  );
  revalidatePath('/admin');
  outcome('/admin?module=settings', 'po_sequence', result);
}

/**
 * Record that a job and vendor has NO paper purchase orders behind it.
 *
 * The same use case with a next number of 1 — the count does not change, but
 * the pair stops being an open question and the go-live verifier stops asking
 * about it. Separate from the form above because it is a different sentence:
 * "the office checked, and this one is new", not "the office says it stands at
 * N". Confusing the two is how a pair WITH paper history gets confirmed as new
 * by somebody clicking through a form.
 */
export async function declarePoPairNewAction(formData: FormData) {
  const result = await run(async (ctx, actor) =>
    await S.initializePoSequence(ctx, actor, {
      jobNumber: String(formData.get('jobNumber') ?? ''),
      vendorId: String(formData.get('vendorId') ?? ''),
      nextSequence: '1',
    }),
  );
  revalidatePath('/admin');
  outcome('/admin?module=settings', 'po_pair_new', result);
}

/**
 * Set the code a vendor is known by inside purchase order numbers. Refused once
 * that vendor has been sent one, because the code is part of every number it
 * carries.
 */
export async function setVendorCodeAction(_prev: unknown, formData: FormData): Promise<Result> {
  const result = await run(async (ctx, actor) =>
    await S.setVendorCode(ctx, actor, String(formData.get('vendorId')), String(formData.get('code') ?? '')),
  );
  revalidatePath('/admin');
  return result;
}

export async function setApprovalAuthorityAction(formData: FormData) {
  await run(async (ctx, actor) =>
    await S.setApprovalAuthority(ctx, actor, String(formData.get('userId')), String(formData.get('canApprove')) === 'true'),
  );
  revalidatePath('/admin');
}

export async function completeRequestAction(formData: FormData) {
  const id = String(formData.get('requestId'));
  const result = await run(async (ctx, actor) => await S.completeRequest(ctx, actor, id, String(formData.get('notes') ?? '')));
  revalidatePath(`/requests/${id}`);
  outcome(`/requests/${id}`, 'completed', result);
}

// --- directories: vendors and jobs -------------------------------------------
// The two things an organization must be able to configure before it can place
// an order. Previously read-only lists, which meant a new customer needed a
// developer to insert rows.

export async function createVendorAction(_prev: unknown, formData: FormData): Promise<Result> {
  const result = await runAsync(async (ctx, actor) =>
    await admin.createVendor(ctx, actor, {
      name: String(formData.get('name') ?? ''),
      // Blank means "derive it from the name" — the vendor's part of every
      // purchase order number issued to it.
      code: String(formData.get('code') ?? ''),
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

/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// Screen 05 — Purchase Order detail.
//
// The durable operational source of truth for one order: who asked, who
// approved, what was ordered, from whom, what has arrived, and everything that
// has happened to it. One page, shared by every role.
//
// What it OFFERS comes from availableActions(), which is computed from the
// same authorize() the server enforces with — so a button that appears always
// works, and one that does not appear would have been refused anyway. Hiding
// is a courtesy; the server is the control.
//
// BR-010: the vendor email is reachable HERE. Not by going back to the request
// that started it, not through a menu — on the purchase order, beside the
// vendor it would be sent to.
// ---------------------------------------------------------------------------
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireAccess, purchasingRequestContext } from '../../../server/session.ts';
import * as S from '../../../server/service.ts';
import { formatMoney, formatQty } from '../../../purchasing/domain/numbers.mjs';
import {
  Alert,
  Badge,
  Button,
  ButtonLink,
  ButtonRow,
  ConfirmSubmit,
  MoreDetails,
  DataGrid,
  DataPoint,
  EmptyState,
  Money,
  PageHeader,
  Panel,
  Qty,
  StatusBadge,
  Table,
  TableFrame,
  TBody,
  TD,
  TH,
  THead,
  Timeline,
  TR,
  TextInput,
  nextActionFor,
  nextStepFor,
} from '../../../components/pcc';
import { OUTCOME_MESSAGES } from '../../outcomes.ts';
import {
  addNoteAction,
  answerClarificationAction,
  cancelRequestAction,
  completeRequestAction,
  generateEmailDraftAction,
  generatePoAction,
  markOrderedAction,
  markReceivedAction,
  submitRequestAction,
  updateTrackingAction,
} from '../../actions.ts';

export const dynamic = 'force-dynamic';

export default async function RequestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const actor = await requireAccess('/requests');

  let detail: any;
  try {
    detail = await S.getRequestDetail(await purchasingRequestContext(), actor, id);
  } catch {
    notFound();
  }

  const r = detail.request;
  const po = detail.purchaseOrder;
  const now = new Date().toISOString();
  const can = (a: string) => detail.actions.includes(a);
  const next = nextActionFor(r);
  const step = nextStepFor(r);

  // DID THAT WORK? Seven actions on this page used to answer that question by
  // re-rendering, which answers it only if you already knew what the page
  // looked like before. They now redirect carrying the outcome, and this is
  // where it is read — once, and gone on the next navigation.
  const query = (await searchParams) ?? {};
  const param = (key: string) => (Array.isArray(query[key]) ? query[key]?.[0] : query[key]) ?? '';
  const done = param('done');
  const failed = param('failed');

  // Receiving progress across the whole order, in quantities rather than in
  // lines: "3 of 5 lines" hides a line that is 1 short of 200.
  const orderedQty = detail.progress.reduce((t: number, p: any) => t + Number(p.finalOrderQty ?? 0), 0);
  const receivedQty = detail.progress.reduce((t: number, p: any) => t + Number(p.receivedQty ?? 0), 0);
  const outstandingLines = detail.progress.filter((p: any) => Number(p.outstandingQty ?? 0) > 0).length;
  const percent = orderedQty > 0 ? Math.min(100, Math.round((receivedQty / orderedQty) * 100)) : 0;

  const vendorEmail = detail.vendorContact?.email ?? null;

  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumb={[
          { label: 'Purchasing', href: '/workshop' },
          { label: po?.poNumber ?? r.requestNumber },
        ]}
        title={po?.poNumber ?? r.requestNumber}
        description={
          po
            ? `Purchase order for request ${r.requestNumber} · job ${r.jobNumber}`
            : `Request on job ${r.jobNumber}, raised by ${r.requestorName}`
        }
        meta={
          <>
            <StatusBadge status={r.status} />
          </>
        }
        actions={
          <ButtonRow>
            {can('review') ? <ButtonLink href={`/requests/${id}/review`}>Open workshop review</ButtonLink> : null}
            {po ? (
              <ButtonLink href={`/requests/${id}/po`} variant="secondary">
                View PO sheet
              </ButtonLink>
            ) : null}
          </ButtonRow>
        }
      />

      {/* The answer to "did that work", first, because it is the most
          perishable thing on the page. */}
      {done && OUTCOME_MESSAGES[done] ? (
        <Alert tone="success" title={OUTCOME_MESSAGES[done]} />
      ) : null}
      {failed ? (
        <Alert tone="danger" title="That did not go through">
          {param('why') || 'The action was refused. Nothing has been changed.'}
        </Alert>
      ) : null}

      {/* WHAT HAPPENS NEXT, AND WHO HAS IT. The second half is the one a
          requester and a foreman actually need: "Needs Approval" does not say
          whether anybody is dealing with it. */}
      <Alert tone={next.actionable ? 'info' : 'success'} title={`${step.state} — ${step.waitingOn}`}>
        <p>
          <span className="font-medium">Next: </span>
          {next.label}
        </p>
        <p className="mt-0.5">
          {outstandingLines > 0
            ? `${outstandingLines} line${outstandingLines === 1 ? '' : 's'} still outstanding — this order stays open until every line is accounted for.`
            : 'Nothing is outstanding on this order.'}
        </p>
      </Alert>

      {/* A rejection has to reach the person who asked, in words, at the top
          of the page. Burying "why" inside a decisions list further down is
          how a requester ends up raising the same request again next week. */}
      {r.status === 'REJECTED' ? (
        <Alert tone="danger" title="This request was rejected">
          <p className="text-base font-medium text-ink">{r.rejectionReason || 'No reason was recorded.'}</p>
          <p className="mt-1 text-sm">
            Decided by {r.approverName ?? 'purchasing'}
            {r.decidedAt ? ` on ${String(r.decidedAt).slice(0, 10)}` : ''}. A rejection is final — if the material is
            still needed, raise a new request that answers the reason above.
          </p>
          {r.decisionNotes && r.decisionNotes !== r.rejectionReason ? (
            <p className="mt-1 text-sm text-ink-soft">{r.decisionNotes}</p>
          ) : null}
        </Alert>
      ) : null}

      {r.status === 'CANCELLED' && r.cancelReason ? (
        <Alert tone="warning" title="This request was cancelled">
          {r.cancelReason}
        </Alert>
      ) : null}

      {r.status === 'CLARIFICATION_REQUESTED' ? (
        <Panel title="The workshop asked a question" subtitle={r.clarificationQuestion ?? ''}>
          {can('respond') ? (
            <form action={answerClarificationAction} className="space-y-2">
              <input type="hidden" name="requestId" value={id} />
              <textarea
                name="answer"
                rows={3}
                placeholder="Your answer…"
                className="w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-base text-ink focus:border-action focus:outline-none focus:ring-1 focus:ring-action"
              />
              <Button type="submit">Answer and resubmit</Button>
            </form>
          ) : (
            <p className="text-sm text-muted">Waiting on {r.requestorName}.</p>
          )}
        </Panel>
      ) : null}

      {/* --- Header context --------------------------------------------- */}
      <Panel title="Order context">
        <DataGrid>
          <DataPoint label="PO number">{po?.poNumber ?? 'not generated yet'}</DataPoint>
          <DataPoint label="Request">{r.requestNumber}</DataPoint>
          <DataPoint label="Job">{r.jobNumber}</DataPoint>
          <DataPoint label="Vendor">{r.vendorName ?? po?.vendorName ?? 'not chosen yet'}</DataPoint>
          <DataPoint label="Requested by">{r.requestorName}</DataPoint>
          <DataPoint label="Approved by">{r.approverName}</DataPoint>
          <DataPoint label="Needed by">{`${r.needByDate ?? '—'} ${r.needByTime ?? ''}`.trim()}</DataPoint>
          <DataPoint label={r.deliveryMethod === 'PICKUP' ? 'Pick up from' : 'Deliver to'}>
            {r.deliveryLocationName}
          </DataPoint>
          <DataPoint label="Submitted">
            {r.submittedAt ? String(r.submittedAt).slice(0, 16).replace('T', ' ') : '—'}
          </DataPoint>
          <DataPoint label="Expected arrival">{r.expectedArrivalDate}</DataPoint>
          <DataPoint label="Tracking">
            {r.trackingNumber ? `${r.trackingCarrier ?? ''} ${r.trackingNumber}`.trim() : null}
          </DataPoint>
          {/* Financial context, shown only to somebody who may act on money.
              A requester does not price the job. */}
          {can('generate_po') || can('mark_ordered') || detail.viewer.isApprover ? (
            <DataPoint label="Estimated total">
              <Money cents={r.estimatedTotalCents} />
            </DataPoint>
          ) : null}
        </DataGrid>

        {r.reason || r.notes ? (
          <div className="mt-4 space-y-2 border-t border-line pt-4 text-sm">
            {r.reason ? (
              <p>
                <span className="font-semibold text-ink-soft">Why: </span>
                {r.reason}
              </p>
            ) : null}
            {r.notes ? (
              <p className="whitespace-pre-line">
                <span className="font-semibold text-ink-soft">Notes: </span>
                {r.notes}
              </p>
            ) : null}
          </div>
        ) : null}
      </Panel>

      {/* --- Vendor + email (BR-010) ------------------------------------- */}
      <Panel
        title="Vendor"
        subtitle="PCC writes the draft. Nothing is sent by this system — a person sends it."
        actions={
          /* The email is drafted automatically when the purchase order is
             created, and "Email vendor" is in the action row above. All that
             belongs here is a way to open what PCC already wrote. */
          detail.emailDrafts.length ? (
            <ButtonLink href={`/requests/${id}/email`} variant="secondary">
              Open the draft
            </ButtonLink>
          ) : null
        }
      >
        {r.vendorName || po ? (
          <DataGrid>
            <DataPoint label="Vendor">{r.vendorName ?? po?.vendorName}</DataPoint>
            <DataPoint label="Contact">{detail.vendorContact?.name}</DataPoint>
            <DataPoint label="Email">{vendorEmail}</DataPoint>
            <DataPoint label="Phone">{detail.vendorContact?.phone}</DataPoint>
          </DataGrid>
        ) : (
          <EmptyState
            title="No vendor chosen yet"
            description="The workshop selects the supplier during review. Until then there is nobody to email."
          />
        )}
      </Panel>

      {/* --- What was asked for ------------------------------------------ */}
      <Panel title="The original request" subtitle="Exactly as submitted. Never overwritten." bodyClassName="">
        <TableFrame className="rounded-none border-0 shadow-none">
          <Table>
            <THead>
              <tr>
                <TH>#</TH>
                <TH>Item</TH>
                <TH align="right">Requested</TH>
                <TH>Unit</TH>
                <TH>Part no.</TH>
              </tr>
            </THead>
            <TBody>
              {detail.originalItems.map((i: any) => (
                <TR key={i.id}>
                  <TD numeric>{i.lineNo}</TD>
                  <TD className="text-ink">
                    {i.description}
                    {i.notes ? <span className="block text-xs text-muted">{i.notes}</span> : null}
                  </TD>
                  <TD align="right" numeric>
                    <Qty value={i.requestedQty} />
                  </TD>
                  <TD>{i.unit}</TD>
                  <TD>{i.stockNumber ?? '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableFrame>
        {detail.attachments.length ? (
          <div className="border-t border-line px-4 py-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Attachments</p>
            <ul className="mt-1 space-y-1 text-sm text-ink-soft">
              {/* A link, not a label. These were listed by name for months
                  while the bytes had no route to reach a browser through. */}
              {detail.attachments.map((a: any) => (
                <li key={a.id}>
                  <a className="underline hover:text-ink" href={`/api/attachments/${a.id}`}>
                    {a.filename}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Panel>

      {/* --- What is being bought ---------------------------------------- */}
      {detail.reviewLines.some((l: any) => l.finalOrderQty > 0 || l.usableStockQty > 0) ? (
        <Panel
          title="What purchasing decided"
          subtitle="Recorded by the workshop. Separate from the request above, and never overwriting it."
          bodyClassName=""
        >
          <TableFrame className="rounded-none border-0 shadow-none">
            <Table>
              <THead>
                <tr>
                  <TH>Item</TH>
                  <TH align="right">Requested</TH>
                  <TH align="right">Stock</TH>
                  <TH align="right">Approved</TH>
                  <TH align="right">Ordering</TH>
                  <TH>Vendor</TH>
                  <TH align="right">Unit cost</TH>
                  <TH align="right">Line total</TH>
                </tr>
              </THead>
              <TBody>
                {detail.reviewLines.map((l: any) => (
                  <TR key={l.requestItemId}>
                    <TD className="text-ink">
                      {l.description}
                      {l.substituteDescription ? (
                        <span className="block text-xs text-muted">substitute: {l.substituteDescription}</span>
                      ) : null}
                    </TD>
                    <TD align="right" numeric>
                      <Qty value={l.requestedQty} />
                    </TD>
                    <TD align="right" numeric>
                      <Qty value={l.usableStockQty} />
                    </TD>
                    <TD align="right" numeric>
                      <Qty value={l.approvedQty} />
                    </TD>
                    <TD align="right" numeric className="font-semibold text-ink">
                      <Qty value={l.finalOrderQty} />
                      {l.replenishmentQty > 0 ? (
                        <span className="block text-xs font-normal text-muted">
                          incl. <Qty value={l.replenishmentQty} /> for stock
                        </span>
                      ) : null}
                    </TD>
                    <TD>{l.vendorName ?? '—'}</TD>
                    <TD align="right" numeric>
                      <Money cents={l.estimatedUnitCostCents} />
                    </TD>
                    <TD align="right" numeric>
                      <Money cents={l.estimatedLineTotalCents} />
                    </TD>
                  </TR>
                ))}
              </TBody>
              <tfoot>
                <tr className="border-t border-line">
                  <td colSpan={7} className="px-3 py-2 text-right text-sm font-medium text-ink-soft">
                    Estimated total
                  </td>
                  <td className="px-3 py-2 text-right text-sm font-semibold tabular-nums text-ink">
                    <Money cents={r.estimatedTotalCents} />
                  </td>
                </tr>
              </tfoot>
            </Table>
          </TableFrame>
        </Panel>
      ) : null}

      {/* --- Receiving progress ------------------------------------------ */}
      {detail.progress.length ? (
        <Panel
          title="Receiving"
          subtitle={
            outstandingLines > 0
              ? `${outstandingLines} of ${detail.progress.length} lines outstanding`
              : 'Every line is accounted for'
          }
          actions={
            can('receive') ? <ButtonLink href={`/requests/${id}/receive`}>Record what arrived</ButtonLink> : undefined
          }
        >
          <div className="mb-4">
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium text-ink">
                {formatQty(receivedQty)} of {formatQty(orderedQty)} received
              </span>
              <span className="tabular-nums text-muted">{percent}%</span>
            </div>
            <div
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Receiving progress"
              className="mt-1 h-2 w-full overflow-hidden rounded-full bg-subtle"
            >
              <div
                className={`h-full ${outstandingLines > 0 ? 'bg-warning' : 'bg-success'}`}
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>

          <TableFrame className="border-0 shadow-none">
            <Table>
              <THead sticky={false}>
                <tr>
                  <TH>Item</TH>
                  <TH align="right">Ordered</TH>
                  <TH align="right">Received</TH>
                  <TH align="right">Damaged</TH>
                  <TH align="right">Backordered</TH>
                  <TH align="right">Outstanding</TH>
                </tr>
              </THead>
              <TBody>
                {detail.progress.map((p: any) => (
                  <TR key={p.purchaseOrderItemId}>
                    <TD className="text-ink">{p.description}</TD>
                    <TD align="right" numeric>
                      <Qty value={p.finalOrderQty} unit={p.unit} />
                    </TD>
                    <TD align="right" numeric>
                      <Qty value={p.receivedQty} />
                    </TD>
                    <TD align="right" numeric>
                      {p.damagedQty > 0 ? <Badge tone="bad">{formatQty(p.damagedQty)} damaged</Badge> : '—'}
                    </TD>
                    <TD align="right" numeric>
                      {p.backorderedQty > 0 ? (
                        <Badge tone="warn">{formatQty(p.backorderedQty)} backordered</Badge>
                      ) : (
                        '—'
                      )}
                    </TD>
                    <TD align="right" numeric className={p.outstandingQty > 0 ? 'font-semibold text-warning' : 'text-success'}>
                      <Qty value={p.outstandingQty} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableFrame>

          {detail.receipts.length ? (
            <ul className="mt-3 space-y-1 text-sm text-ink-soft">
              {detail.receipts.map((rec: any) => (
                <li key={rec.id}>
                  <Link href={`/receipts/${rec.id}`} className="text-action hover:underline">
                    {rec.receivedDate}
                  </Link>
                  {rec.packingSlipNumber ? ` · packing slip ${rec.packingSlipNumber}` : ''}
                  {rec.isFinal ? ' · final' : ' · partial'}
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
      ) : null}

      {/* --- What to do next ---------------------------------------------
          NOT a generic actions panel. The old one listed every transition the
          state machine permits, in one undifferentiated row, behind a heading
          that told the reader nothing about which of them was theirs to press.
          Mike's sequence is fixed and short — raise it, print it, email it,
          mark it ordered, mark it received — so it is shown as that sequence,
          with the next step first and largest.

          Confirmation dialogs are gone from the ordinary steps. Marking an
          order placed is something Mike does several times a day and it is
          recorded, reversible in the sense that matters (the record shows who
          and when) and not destructive. Cancelling still asks, because it is
          terminal; so does completing, on the paths that still offer it. */}
      <Panel title="What to do next">
        <ButtonRow>
          {can('submit') ? (
            <form action={submitRequestAction}>
              <input type="hidden" name="requestId" value={id} />
              <Button type="submit" size="l">Submit to workshop</Button>
            </form>
          ) : null}

          {can('generate_po') ? (
            <form action={generatePoAction}>
              <input type="hidden" name="requestId" value={id} />
              <Button type="submit" size="l">Create purchase order</Button>
            </form>
          ) : null}

          {/* PRINT IS FIRST once the PO exists. The hardcopy is the artefact
              the rest of the Lippolis process hangs off — the receipt gets
              stapled to it and the packet gets filed. */}
          {po ? (
            <ButtonLink href={`/requests/${id}/po`} size="l">
              Print PO
            </ButtonLink>
          ) : null}

          {po && can('draft_email') ? (
            <form action={generateEmailDraftAction}>
              <input type="hidden" name="requestId" value={id} />
              <Button type="submit" variant="secondary" size="l">Email vendor</Button>
            </form>
          ) : null}
          {po && !can('draft_email') && detail.emailDrafts.length ? (
            <ButtonLink href={`/requests/${id}/email`} variant="secondary" size="l">
              Email vendor
            </ButtonLink>
          ) : null}

          {/* ONE CLICK. No modal: this is a routine act, done many times a day,
              and the audit trail records who and when without asking. */}
          {can('mark_ordered') ? (
            <form action={markOrderedAction}>
              <input type="hidden" name="requestId" value={id} />
              <Button type="submit" size="l">Mark ordered</Button>
            </form>
          ) : null}

          {can('receive') ? (
            <form action={markReceivedAction}>
              <input type="hidden" name="requestId" value={id} />
              <Button type="submit" size="l">It arrived</Button>
            </form>
          ) : null}

          {can('complete') ? (
            <form action={completeRequestAction}>
              <input type="hidden" name="requestId" value={id} />
              <Button type="submit" variant="secondary" size="l">Close it out</Button>
            </form>
          ) : null}
        </ButtonRow>

        {/* The exceptional delivery, and the stored paperwork — present, quiet. */}
        {(can('receive') || po?.documents?.length) ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {can('receive') ? (
              <a href={`/requests/${id}/receive`} className="text-muted underline underline-offset-2 hover:text-ink-soft">
                Only part of it arrived
              </a>
            ) : null}
            {(po?.documents ?? []).map((d: any) => (
              <a key={d.id} href={`/api/documents/${d.id}`} className="text-muted underline underline-offset-2 hover:text-ink-soft">
                {d.filename}
              </a>
            ))}
          </div>
        ) : null}

        {/* Tracking is not part of the ordinary path — most of this is
            next-day counter pickup or delivery — so it stays available and
            stays out of the way. */}
        {['ORDERED', 'PARTIALLY_RECEIVED', 'EMAIL_DRAFTED'].includes(r.status) && can('add_tracking') ? (
          <MoreDetails label="Tracking" hint="only if the vendor gave you a number">
            <form action={updateTrackingAction} className="grid grid-cols-1 gap-2 sm:grid-cols-4">
              <input type="hidden" name="requestId" value={id} />
              <TextInput name="trackingNumber" placeholder="Tracking number" defaultValue={r.trackingNumber ?? ''} aria-label="Tracking number" />
              <TextInput name="carrier" placeholder="Carrier" defaultValue={r.trackingCarrier ?? ''} aria-label="Carrier" />
              <TextInput type="date" name="expectedArrivalDate" defaultValue={r.expectedArrivalDate ?? ''} aria-label="Expected arrival" />
              <Button type="submit" variant="secondary">Save tracking</Button>
            </form>
          </MoreDetails>
        ) : null}
      </Panel>

      {/* --- Decisions ---------------------------------------------------- */}
      {detail.approvals.length ? (
        <Panel title="Decisions">
          <ul className="space-y-2 text-sm">
            {detail.approvals.map((a: any) => (
              <li key={a.id} className="rounded-md border border-line p-3">
                <div className="font-medium text-ink">
                  {a.decision} · {a.approverName} · {String(a.decidedAt).slice(0, 16).replace('T', ' ')}
                </div>
                {a.reason ? <div className="text-ink-soft">Reason: {a.reason}</div> : null}
                {a.notes ? <div className="text-muted">Notes: {a.notes}</div> : null}
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {/* --- Activity ------------------------------------------------------ */}
      <Panel title="Activity" subtitle="Every meaningful action, with who did it and when (BR-008).">
        <Timeline entries={detail.timeline} />
        <form action={addNoteAction} className="mt-4 flex flex-wrap gap-2">
          <input type="hidden" name="requestId" value={id} />
          <TextInput name="note" placeholder="Add a note to the record…" aria-label="Add a note" wrapperClassName="flex-1" className="min-w-48" />
          <Button type="submit" variant="secondary">
            Add note
          </Button>
        </form>
      </Panel>

      {/* --- Cancel (BR-009: cancel, never delete) ------------------------- */}
      {can('cancel') || can('cancel_any') ? (
        <Panel title="Cancel this request" subtitle="Purchasing records are never deleted. Cancelling keeps the history and closes the work.">
          <form action={cancelRequestAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="requestId" value={id} />
            <TextInput
              name="reason"
              label="Reason for cancelling"
              required
              wrapperClassName="max-w-sm flex-1"
              hint="This is recorded against the request permanently."
            />
            <ConfirmSubmit
              label="Cancel request"
              title="Cancel this request?"
              body={
                <>
                  <p>
                    The record stays — nothing is deleted. It moves to Cancelled, which is terminal: a correction
                    after this is a new request.
                  </p>
                  {['ORDERED', 'PARTIALLY_RECEIVED'].includes(r.status) ? (
                    <p className="mt-2 font-medium text-danger">
                      This order has already been placed with a vendor. Cancelling here does not tell them — somebody
                      has to.
                    </p>
                  ) : null}
                </>
              }
              requireTyping="CANCEL"
              confirmLabel="Cancel the request"
            />
          </form>
        </Panel>
      ) : null}
    </div>
  );
}

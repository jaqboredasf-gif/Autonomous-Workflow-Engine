/* eslint-disable @typescript-eslint/no-explicit-any */
// The purchase order: on screen, printable, and downloadable as the stored PDF.
// The PDF is generated once at approval time and kept with the request; this
// page renders the same data, it does not re-derive a second version of it.
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { requireAccess, purchasingRequestContext } from '../../../../server/session.ts';
import * as S from '../../../../server/service.ts';
import { formatMoney, formatQty } from '../../../../purchasing/domain/numbers.mjs';
import { Empty, Section, buttonClass, secondaryButtonClass } from '../../../../components/ui';
import { AutoPrint, BrandMark, PrintButton } from '../../../../components/pcc';
import { generateEmailDraftAction } from '../../../actions.ts';

export const dynamic = 'force-dynamic';

export default async function PoPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const actor = await requireAccess('/requests');
  // Set only by the redirect out of "Approve and print PO".
  const printed = (await searchParams)?.printed === '1';

  const ctx = await purchasingRequestContext();
  let detail: any;
  try {
    detail = await S.getRequestDetail(ctx, actor, id);
  } catch {
    notFound();
  }
  if (!detail.purchaseOrder) {
    return (
      <Section title="Purchase order">
        <Empty>No purchase order has been generated for this request yet.</Empty>
      </Section>
    );
  }

  const view = await S.purchaseOrderView(ctx, detail.purchaseOrder.id);
  const doc = detail.purchaseOrder.documents[0];

  // Print the money columns only when somebody actually recorded money. A
  // column of "$0.00" is not information; it is three inches of paper telling
  // the reader nothing, on a sheet whose whole job is to be scannable.
  const showCosts = view.items.some((i: any) => Number(i.estimatedUnitCostCents ?? 0) > 0);

  // Job name and address, when the job is in the directory. The job NUMBER is
  // what the record carries and what the vendor sees; the name and address are
  // what makes the paper useful to a person holding it.
  const job = await S.listJobs(ctx, actor)
    .then((js: any[]) => js.find((j) => String(j.job_number ?? j.jobNumber) === String(view.request.jobNumber)) ?? null)
    .catch(() => null);

  // WORKSHOP -> SHOP, everything else -> JOB. The company's form has exactly
  // two boxes and PCC has four destination kinds, so the mapping is stated
  // once, here, rather than implied by a ternary in the markup.
  const kind = String(view.request.deliveryLocationKind ?? '');
  const shipTo = kind === 'WORKSHOP' || kind === 'OFFICE' ? 'SHOP' : 'JOB';

  return (
    <div className="space-y-4">
      {/* Arriving straight from "Approve and print PO" opens the print dialog,
          because that is the step he came here to perform. Opening the page any
          other way does not. */}
      <AutoPrint when={printed} />

      <div className="no-print flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-slate-900">Purchase order {view.purchaseOrder.poNumber}</h1>
        <div className="flex flex-wrap gap-2">
          {/* FIRST-CLASS, and first in the row: he prints every PO and files the
              vendor's receipt against the paper. */}
          <PrintButton />
          {doc ? (
            <a href={`/api/documents/${doc.id}`} className={secondaryButtonClass}>
              Download PDF
            </a>
          ) : null}
          {/* The vendor email is reachable FROM the purchase order, which is
              where a person is standing when they decide to send it. Before
              this, the only create button lived back on the request page and
              this link led to a dead end. */}
          {detail.emailDrafts.length ? (
            <Link href={`/requests/${id}/email`} className={secondaryButtonClass}>
              View vendor email draft
            </Link>
          ) : (
            <form action={generateEmailDraftAction}>
              <input type="hidden" name="requestId" value={id} />
              <button className={buttonClass}>Create vendor email draft</button>
            </form>
          )}
          <Link href={`/requests/${id}`} className={secondaryButtonClass}>
            Back to request
          </Link>
        </div>
      </div>

      {/* ------------------------------------------------------------------
          THE LIPPOLIS PURCHASE ORDER.

          Laid out from the company's own paper form, because the paper form is
          the business reference: Mike prints this, writes on it, staples the
          vendor's receipt to it and files the pair. A sheet that rearranged
          his fields would make the filing cabinet inconsistent for no gain.

          Reproduced as HTML and CSS — NOT as text positioned over a photograph
          of the form. A scanned background prints grey, cannot reflow when an
          order runs to two pages, and would carry somebody's handwriting from
          2019 onto every purchase order this company issues.

          THE RULE FOR EVERY FIELD: print what PCC knows, and leave a RULED
          LINE where it does not. A blank line is an invitation to write; an
          invented value is a lie on a document that goes to a supplier. Three
          fields are deliberately blank, and each is marked below.
      ------------------------------------------------------------------ */}
      <div className="print-sheet mx-auto max-w-3xl border border-slate-300 bg-white p-8">
        {/* --- header ------------------------------------------------------ */}
        <div className="flex items-start justify-between border-b-2 border-slate-800 pb-3">
          <div className="flex items-start gap-3">
            <BrandMark size={44} />
            <div>
              <div className="text-xl font-bold tracking-tight">{view.org.name}</div>
              {view.org.address ? <div className="text-xs text-slate-700">{view.org.address}</div> : null}
              {view.org.phone ? <div className="text-xs text-slate-700">{view.org.phone}</div> : null}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xl font-bold uppercase tracking-widest">Purchase Order</div>
            <div className="mt-1 text-2xl font-bold tabular-nums">{view.purchaseOrder.poNumber}</div>
          </div>
        </div>

        {/* --- vendor / date / job ------------------------------------------
            The form's top block, in the order it appears on the paper. */}
        <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
          <Field label="Vendor" value={view.vendor?.name} wide>
            {view.vendorContact?.name ? <div className="text-xs text-slate-700">Attn: {view.vendorContact.name}</div> : null}
            {view.vendor?.address ? <div className="text-xs text-slate-700">{view.vendor.address}</div> : null}
            {view.vendor?.phone ? <div className="text-xs text-slate-700">{view.vendor.phone}</div> : null}
            {view.vendor?.accountNumber ? (
              <div className="text-xs text-slate-700">Account {view.vendor.accountNumber}</div>
            ) : null}
          </Field>
          <div className="space-y-3">
            <Field label="Date" value={String(view.purchaseOrder.generatedAt).slice(0, 10)} />
            <Field label="Requisitioned by" value={view.request.requestorName} />
          </div>

          <Field label="Job name" value={job?.name ?? null} />
          <Field label="Job number" value={view.request.jobNumber} />
          <Field
            label="Job address"
            value={job?.site_address ?? job?.siteAddress ?? view.request.deliveryAddress ?? null}
            wide
          />
        </div>

        {/* --- the four boxes ----------------------------------------------
            TAXABLE is the one field on this form PCC genuinely does not know:
            nothing in purchasing records a tax status, and guessing "No"
            because it is the common case would put a wrong answer on a
            document the office relies on. Printed as two boxes to tick.

            SHIP TO is known — the destination's KIND is what the workshop
            being a real place buys us — so it prints ticked. WHEN SHIP is the
            need-by date. SHIP VIA is known only when the request said pick-up. */}
        <div className="mt-4 grid grid-cols-4 gap-x-6 gap-y-2 border-y border-slate-400 py-3 text-sm">
          <div>
            <FieldLabel>Taxable</FieldLabel>
            <div className="mt-1 flex gap-4">
              <Tick label="Yes" checked={null} />
              <Tick label="No" checked={null} />
            </div>
          </div>
          <div>
            <FieldLabel>Ship to</FieldLabel>
            <div className="mt-1 flex gap-4">
              <Tick label="Job" checked={shipTo === 'JOB'} />
              <Tick label="Shop" checked={shipTo === 'SHOP'} />
            </div>
          </div>
          <Field
            label="When ship"
            value={view.request.needByDate ? `${view.request.needByDate}${view.request.needByTime ? ` ${view.request.needByTime}` : ''}` : null}
          />
          {/* PICKUP is a fact the request records. A delivery's carrier is not
              — PCC never asks for one — so it prints a line to write on. */}
          <Field label="Ship via" value={view.request.deliveryMethod === 'PICKUP' ? 'Will call / pick up' : null} />
        </div>

        {/* --- the lines ----------------------------------------------------
            THREE QUANTITIES, THREE COLUMNS, because they are three different
            facts and collapsing them loses the one Mike needs at the tailgate:

              JOB QTY    what the job asked for          10
              SHOP       what was already on the shelf    2
              QTY ORD.   what this vendor is selling      8

            SHOP is deliberately not called "received" — it is stock Lippolis
            already owned, and the material this order covers has not arrived
            yet. QTY REC. is the one somebody writes in by hand when it does, so
            the same sheet works before and after the delivery. */}
        <table className="mt-4 w-full text-left text-sm">
          <thead className="border-y border-slate-800 text-[11px] uppercase tracking-wide">
            <tr>
              <th className="w-14 py-1.5 pr-2 text-right">Job qty</th>
              <th className="w-14 py-1.5 pr-2 text-right">Shop</th>
              <th className="w-16 py-1.5 pr-2 text-right">Qty ord.</th>
              <th className="w-16 py-1.5 pr-2 text-right">Qty rec.</th>
              <th className="py-1.5 pr-2">Stock no. / Description</th>
              {showCosts ? <th className="w-24 py-1.5 pr-2 text-right">Unit price</th> : null}
              {showCosts ? <th className="w-24 py-1.5 text-right">Total</th> : null}
            </tr>
          </thead>
          <tbody>
            {view.items.map((i: any) => (
              <tr key={i.lineNo} className="border-b border-slate-200 align-top">
                <td className="py-1.5 pr-2 text-right tabular-nums text-slate-600">
                  {formatQty(i.requestedQty ?? 0)}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-slate-600">
                  {Number(i.workshopStockQty ?? 0) > 0 ? formatQty(i.workshopStockQty) : '—'}
                </td>
                <td className="py-1.5 pr-2 text-right font-semibold tabular-nums">
                  {formatQty(i.finalOrderQty)}
                  {i.unit ? <span className="ml-0.5 text-[11px] font-normal text-slate-600">{i.unit}</span> : null}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  {Number(i.receivedQty ?? 0) > 0 ? (
                    formatQty(i.receivedQty)
                  ) : (
                    <span className="inline-block w-10 border-b border-slate-400">&nbsp;</span>
                  )}
                </td>
                <td className="py-1.5 pr-2">
                  {i.stockNumber ? <span className="font-medium tabular-nums">{i.stockNumber} · </span> : null}
                  {i.description}
                  {i.substituteFor ? (
                    <span className="block text-[11px] text-slate-600">substitute for: {i.substituteFor}</span>
                  ) : null}
                  {i.expectedArrivalDate ? (
                    <span className="block text-[11px] text-slate-600">expected {i.expectedArrivalDate}</span>
                  ) : null}
                </td>
                {showCosts ? (
                  <td className="py-1.5 pr-2 text-right tabular-nums">{formatMoney(i.estimatedUnitCostCents)}</td>
                ) : null}
                {showCosts ? (
                  <td className="py-1.5 text-right tabular-nums">{formatMoney(i.lineTotalCents)}</td>
                ) : null}
              </tr>
            ))}
            {/* A few ruled lines, because material gets added at the counter
                and the paper has to accommodate it. */}
            {BLANK_LINES.map((n) => (
              <tr key={`blank-${n}`} className="border-b border-slate-200">
                <td className="py-2.5">&nbsp;</td>
                <td />
                <td />
                <td />
                <td />
                {showCosts ? <td /> : null}
                {showCosts ? <td /> : null}
              </tr>
            ))}
          </tbody>
          {showCosts ? (
            <tfoot>
              <tr className="border-t-2 border-slate-800">
                <td colSpan={6} className="py-2 pr-2 text-right font-semibold">
                  Total
                </td>
                <td className="py-2 text-right font-bold tabular-nums">
                  {formatMoney(view.purchaseOrder.estimatedTotalCents)}
                </td>
              </tr>
            </tfoot>
          ) : null}
        </table>

        {view.purchaseOrder.notes ? (
          <div className="mt-3 text-sm">
            <FieldLabel>Notes</FieldLabel>
            <div className="whitespace-pre-line">{view.purchaseOrder.notes}</div>
          </div>
        ) : null}

        {/* --- authorisation and the filing block --------------------------
            AUTHORIZED BY prints the approver PCC recorded, and still carries a
            rule beneath it: the paper is signed, and a printed name is not a
            signature. */}
        <div className="print-keep-together mt-6 border-t border-slate-400 pt-3">
          <div className="grid grid-cols-3 gap-6 text-xs">
            <div>
              <FieldLabel>Authorized by</FieldLabel>
              <div className="mt-3 min-h-4">{view.approver?.name ?? ''}</div>
              <div className="border-b border-slate-500" />
            </div>
            <div>
              <FieldLabel>Date ordered</FieldLabel>
              <div className="mt-3 min-h-4">
                {view.purchaseOrder.orderedAt ? String(view.purchaseOrder.orderedAt).slice(0, 10) : ''}
              </div>
              <div className="border-b border-slate-500" />
            </div>
            <div>
              <FieldLabel>Receipt attached</FieldLabel>
              <div className="mt-3 min-h-4">&nbsp;</div>
              <div className="border-b border-slate-500" />
            </div>
          </div>

          <p className="mt-4 border border-slate-400 p-2 text-[11px] leading-snug text-slate-800">
            <strong>Reference this purchase order number on all packing slips and invoices.</strong> Invoices without
            a purchase order number may be returned unpaid. Deliver only the quantities listed above; any substitution
            or back-order must be agreed with purchasing before shipping.
          </p>
          <p className="mt-2 text-[11px] text-slate-600">
            PCC request {view.request.requestNumber}
          </p>
        </div>
      </div>
    </div>
  );
}

/** A label in the form's vocabulary: small, upright, above its value. */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="block text-[10px] font-bold uppercase tracking-wider text-slate-600">{children}</span>;
}

/**
 * One field on the form.
 *
 * An absent value draws a RULED LINE rather than an em-dash or the word
 * "none". This sheet is filled in by hand as often as it is read, and a line is
 * where somebody writes; a dash says the question was answered and the answer
 * was nothing.
 */
function Field({
  label,
  value,
  wide = false,
  children,
}: {
  label: string;
  value?: string | null;
  wide?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className={wide ? 'col-span-1' : undefined}>
      <FieldLabel>{label}</FieldLabel>
      {value ? (
        <div className="font-medium">{value}</div>
      ) : (
        <div className="mt-3 border-b border-slate-500" aria-label={`${label} (write in)`} />
      )}
      {children}
    </div>
  );
}

/**
 * A tick box. `checked === null` means PCC does not know — the box prints
 * empty for a person to mark, which is what the paper form has always been for.
 */
function Tick({ label, checked }: { label: string; checked: boolean | null }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-flex h-3.5 w-3.5 items-center justify-center border border-slate-700 text-[10px] font-bold leading-none">
        {checked ? 'X' : ''}
      </span>
      <span className="text-xs">{label}</span>
    </span>
  );
}

/** Ruled lines under the printed material, for what gets added at the counter. */
const BLANK_LINES = [1, 2, 3];

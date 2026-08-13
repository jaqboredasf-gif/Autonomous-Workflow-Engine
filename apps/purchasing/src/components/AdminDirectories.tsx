'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// Directory rows arrive provider-shaped (snake_case, provider-specific extras)
// and this is a table rendering them, not a domain model. Same convention as
// every other screen that touches repository records directly.

// ---------------------------------------------------------------------------
// AdminDirectories.tsx — vendors and jobs, editable.
//
// These were read-only lists, which meant a new organization needed a developer
// to insert rows before it could place an order. They are now the screens that
// make "give a contractor a URL and they configure their own purchasing" true.
//
// Two deliberate choices:
//   * Neither directory offers DELETE. A vendor named on a past purchase order
//     and a job named on a past request have to stay resolvable, so retiring
//     sets a flag and the record keeps explaining itself.
//   * A job's NUMBER is shown but not editable after creation. It is written as
//     text onto every request and PO; changing it would orphan them.
// ---------------------------------------------------------------------------

import { useActionState, useState } from 'react';

import {
  createVendorAction, updateVendorAction, setVendorActiveAction, setVendorCodeAction,
  createJobAction, updateJobAction,
} from '../app/actions.ts';
import { Section, inputClass, buttonClass, secondaryButtonClass, Empty } from './ui';

type Result = { ok: boolean; error?: string } | null;

function Problem({ state }: { state: Result }) {
  if (!state || state.ok) return null;
  return (
    <p role="alert" className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
      {state.error ?? 'That could not be saved.'}
    </p>
  );
}

function Saved({ state, what }: { state: Result; what: string }) {
  if (!state || !state.ok) return null;
  return (
    <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
      {what} saved.
    </p>
  );
}

// ---------------------------------------------------------------------------

export function AdminVendors({ vendors }: { vendors: any[] }) {
  const [addState, addAction, adding] = useActionState<Result, FormData>(createVendorAction, null);
  const [editState, editAction, editing] = useActionState<Result, FormData>(updateVendorAction, null);
  const [codeState, codeAction, savingCode] = useActionState<Result, FormData>(setVendorCodeAction, null);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Section
      title="Vendors"
      subtitle="Who you buy from. A vendor's address and contact are what a purchase order and its email are addressed to."
    >
      <form action={addAction} className="mb-5 grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-slate-700 sm:col-span-1">
          Vendor name <span aria-hidden className="text-rose-600">*</span>
          <input name="name" required className={inputClass} placeholder="Graybar" />
        </label>
        {/* THE CODE THAT APPEARS IN EVERY PURCHASE ORDER NUMBER SENT TO THIS
            VENDOR (the COOPER in 1234-COOPER-1). Left blank it is derived from
            the name; it can be shortened here or on the vendor until the first
            order is raised, and is frozen after that. */}
        <label className="text-xs text-slate-700">
          PO code
          <input name="code" className={inputClass} placeholder="derived from the name" />
        </label>
        <label className="text-xs text-slate-700">
          Account number
          <input name="accountNumber" className={inputClass} placeholder="optional" />
        </label>
        <label className="text-xs text-slate-700">
          Phone
          <input name="phone" className={inputClass} placeholder="optional" />
        </label>
        <label className="text-xs text-slate-700 sm:col-span-3">
          Address
          <input name="address" className={inputClass} placeholder="Where purchase orders are sent" />
        </label>
        <label className="text-xs text-slate-700">
          Orders contact
          <input name="contactName" className={inputClass} placeholder="optional" />
        </label>
        <label className="text-xs text-slate-700">
          Orders email
          <input name="contactEmail" type="email" className={inputClass} placeholder="orders@vendor.com" />
        </label>
        <label className="text-xs text-slate-700">
          Contact phone
          <input name="contactPhone" className={inputClass} placeholder="optional" />
        </label>
        <div className="sm:col-span-3 space-y-2">
          <Problem state={addState} />
          <Saved state={addState} what="Vendor" />
          <button type="submit" disabled={adding} className={buttonClass}>
            {adding ? 'Adding…' : 'Add vendor'}
          </button>
        </div>
      </form>

      {vendors.length === 0 ? (
        <Empty>No vendors yet. Add the first one above — you need at least one to send a purchase order.</Empty>
      ) : (
        <ul className="divide-y divide-slate-200 border-t border-slate-200">
          {vendors.map((v: any) => (
            <li key={v.id} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium text-slate-900">
                    {v.name}{' '}
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">
                      {v.code ?? '—'}
                    </span>
                  </div>
                  <div className="text-xs text-slate-600">
                    {v.contact_name
                      ? `${v.contact_name}${v.contact_email ? ` · ${v.contact_email}` : ''}`
                      : 'No orders contact on file — a vendor email cannot be addressed without one.'}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setOpen(open === v.id ? null : v.id)}
                    className={secondaryButtonClass}
                    aria-expanded={open === v.id}
                  >
                    {open === v.id ? 'Close' : 'Edit'}
                  </button>
                  <form action={setVendorActiveAction}>
                    <input type="hidden" name="vendorId" value={v.id} />
                    <input type="hidden" name="isActive" value="false" />
                    <button type="submit" className={secondaryButtonClass}>Retire</button>
                  </form>
                </div>
              </div>

              {open === v.id && (
                <form action={editAction} className="mt-3 grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-3">
                  <input type="hidden" name="vendorId" value={v.id} />
                  <label className="text-xs text-slate-700">
                    Name
                    <input name="name" defaultValue={v.name} className={inputClass} />
                  </label>
                  <label className="text-xs text-slate-700">
                    Account number
                    <input name="accountNumber" defaultValue={v.account_number ?? ''} className={inputClass} />
                  </label>
                  <label className="text-xs text-slate-700">
                    Phone
                    <input name="phone" defaultValue={v.phone ?? ''} className={inputClass} />
                  </label>
                  <label className="text-xs text-slate-700 sm:col-span-3">
                    Address
                    <input name="address" defaultValue={v.address ?? ''} className={inputClass} />
                  </label>
                  <label className="text-xs text-slate-700">
                    Orders contact
                    <input name="contactName" defaultValue={v.contact_name ?? ''} className={inputClass} />
                  </label>
                  <label className="text-xs text-slate-700">
                    Orders email
                    <input name="contactEmail" type="email" defaultValue={v.contact_email ?? ''} className={inputClass} />
                  </label>
                  <label className="text-xs text-slate-700">
                    Contact phone
                    <input name="contactPhone" defaultValue={v.contact_phone ?? ''} className={inputClass} />
                  </label>
                  <div className="sm:col-span-3 space-y-2">
                    <Problem state={editState} />
                    <button type="submit" disabled={editing} className={buttonClass}>
                      {editing ? 'Saving…' : 'Save vendor'}
                    </button>
                    <p className="text-xs text-slate-600">
                      Renaming a vendor does not change any purchase order number already issued to it. The name
                      and the PO code are kept apart on purpose.
                    </p>
                  </div>
                </form>
              )}

              {/* ITS OWN FORM, because it is its own act with its own refusal:
                  once this vendor has been sent a purchase order, the code is
                  part of every number it carries and cannot be changed. */}
              {open === v.id && (
                <form action={codeAction} className="mt-3 grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-3">
                  <input type="hidden" name="vendorId" value={v.id} />
                  <label className="text-xs text-slate-700 sm:col-span-2">
                    PO code — the vendor&rsquo;s part of a purchase order number, e.g. {v.code ?? 'COOPER'} in{' '}
                    <span className="font-mono">1234-{v.code ?? 'COOPER'}-1</span>
                    <input name="code" defaultValue={v.code ?? ''} className={inputClass} />
                  </label>
                  <div className="sm:col-span-3 space-y-2">
                    <Problem state={codeState} />
                    <Saved state={codeState} what="PO code" />
                    <button type="submit" disabled={savingCode} className={secondaryButtonClass}>
                      {savingCode ? 'Saving…' : 'Change PO code'}
                    </button>
                    <p className="text-xs text-slate-600">
                      Letters and digits only. Changeable until the first purchase order goes to this vendor;
                      after that it is fixed, because it is printed on their paperwork.
                    </p>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------

export function AdminJobs({ jobs }: { jobs: any[] }) {
  const [addState, addAction, adding] = useActionState<Result, FormData>(createJobAction, null);
  const [editState, editAction, editing] = useActionState<Result, FormData>(updateJobAction, null);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Section
      title="Jobs"
      subtitle="Your job sites. Requests are raised against a job, deliveries are confirmed by whoever is assigned to it."
    >
      <form action={addAction} className="mb-5 grid gap-3 sm:grid-cols-3">
        <label className="text-xs text-slate-700">
          Job number <span aria-hidden className="text-rose-600">*</span>
          <input name="jobNumber" required className={inputClass} placeholder="24-118" />
        </label>
        <label className="text-xs text-slate-700 sm:col-span-2">
          Job name <span aria-hidden className="text-rose-600">*</span>
          <input name="name" required className={inputClass} placeholder="Harrison Gym" />
        </label>
        <label className="text-xs text-slate-700">
          Customer
          <input name="customer" className={inputClass} placeholder="optional" />
        </label>
        <label className="text-xs text-slate-700 sm:col-span-2">
          Site address
          <input name="siteAddress" className={inputClass} placeholder="Where material is delivered" />
        </label>
        <label className="text-xs text-slate-700 sm:col-span-3">
          Delivery instructions
          <input name="deliveryInstructions" className={inputClass} placeholder="Gate code, receiving hours, who to call" />
        </label>
        <div className="sm:col-span-3 space-y-2">
          <Problem state={addState} />
          <Saved state={addState} what="Job" />
          <button type="submit" disabled={adding} className={buttonClass}>
            {adding ? 'Adding…' : 'Add job'}
          </button>
        </div>
      </form>

      {jobs.length === 0 ? (
        <Empty>No jobs yet. Add one above so requests can be raised against it.</Empty>
      ) : (
        <ul className="divide-y divide-slate-200 border-t border-slate-200">
          {jobs.map((j: any) => (
            <li key={j.id} className="py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium text-slate-900">
                    {j.job_number} — {j.name}
                    {j.status && j.status !== 'ACTIVE' && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
                        {j.status.toLowerCase().replace('_', ' ')}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-600">
                    {[j.customer, j.address ?? j.site_address].filter(Boolean).join(' · ') || 'No customer or site address on file'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(open === j.id ? null : j.id)}
                  className={secondaryButtonClass}
                  aria-expanded={open === j.id}
                >
                  {open === j.id ? 'Close' : 'Edit'}
                </button>
              </div>

              {open === j.id && (
                <form action={editAction} className="mt-3 grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-3">
                  <input type="hidden" name="jobId" value={j.id} />
                  <div className="text-xs text-slate-600 sm:col-span-3">
                    Job number <strong>{j.job_number}</strong> cannot be changed: it is written onto every request
                    and purchase order raised against this job. Retire this job and create its replacement instead.
                  </div>
                  <label className="text-xs text-slate-700 sm:col-span-2">
                    Job name
                    <input name="name" defaultValue={j.name} className={inputClass} />
                  </label>
                  <label className="text-xs text-slate-700">
                    Status
                    <select name="status" defaultValue={j.status ?? 'ACTIVE'} className={inputClass}>
                      <option value="ACTIVE">Active</option>
                      <option value="ON_HOLD">On hold</option>
                      <option value="COMPLETED">Completed</option>
                      <option value="CANCELLED">Cancelled</option>
                    </select>
                  </label>
                  <label className="text-xs text-slate-700">
                    Customer
                    <input name="customer" defaultValue={j.customer ?? ''} className={inputClass} />
                  </label>
                  <label className="text-xs text-slate-700 sm:col-span-2">
                    Site address
                    <input name="siteAddress" defaultValue={j.address ?? j.site_address ?? ''} className={inputClass} />
                  </label>
                  <label className="text-xs text-slate-700 sm:col-span-3">
                    Delivery instructions
                    <input name="deliveryInstructions" defaultValue={j.delivery_instructions ?? ''} className={inputClass} />
                  </label>
                  <div className="sm:col-span-3 space-y-2">
                    <Problem state={editState} />
                    <button type="submit" disabled={editing} className={buttonClass}>
                      {editing ? 'Saving…' : 'Save job'}
                    </button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

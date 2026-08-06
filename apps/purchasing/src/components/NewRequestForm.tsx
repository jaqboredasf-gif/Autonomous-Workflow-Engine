'use client';
// The field intake form. Built thumb-first: one column, large targets, no
// horizontal scrolling, and NOTHING about vendors, prices, workshop stock or
// priority — the requestor says what is needed and when, and that is all.
import { useActionState, useState } from 'react';

import { createRequestAction } from '../app/actions.ts';
import { UNITS } from '../purchasing/domain/numbers.mjs';
import { Field, buttonClass, inputClass, secondaryButtonClass } from './ui';

type Line = { key: number; description: string; qty: string; unit: string; stockNumber: string; notes: string };

const emptyLine = (key: number): Line => ({ key, description: '', qty: '', unit: 'ea', stockNumber: '', notes: '' });

export default function NewRequestForm({
  actorName,
  locations,
  jobs,
}: {
  actorName: string;
  locations: Array<{ id: string; name: string; kind: string }>;
  jobs: Array<{ number: string; name: string }>;
}) {
  const [state, formAction, pending] = useActionState(createRequestAction, null as any);
  const [lines, setLines] = useState<Line[]>([emptyLine(1)]);

  const update = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const errors: Array<{ field: string; message: string }> = state?.details ?? [];
  const errorFor = (field: string) => errors.find((e) => e.field === field || e.field.startsWith(field))?.message;

  return (
    <form action={formAction} className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">New purchase request</h1>
        <p className="mt-1 text-sm text-slate-600">
          Requested by <strong>{actorName}</strong>. The workshop decides stock, vendor, cost and how much to order.
        </p>
      </div>

      {state && state.ok === false ? (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
          <p className="font-medium">{state.error}</p>
          {errors.length ? (
            <ul className="mt-1 list-disc pl-5">
              {errors.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <Field label="Job number" required hint="One request covers exactly one job.">
          <input name="jobNumber" list="job-numbers" className={inputClass} inputMode="text" autoComplete="off" />
          <datalist id="job-numbers">
            {jobs.map((j) => (
              <option key={j.number} value={j.number}>
                {j.name}
              </option>
            ))}
          </datalist>
        </Field>
        {errorFor('jobNumber') ? <p className="text-xs text-rose-700">{errorFor('jobNumber')}</p> : null}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Need-by date" required>
            <input type="date" name="needByDate" className={inputClass} />
          </Field>
          <Field label="Need-by time" required>
            <input type="time" name="needByTime" className={inputClass} />
          </Field>
        </div>

        <Field label="Delivery or pickup" required>
          <select name="deliveryMethod" className={inputClass} defaultValue="DELIVERY">
            <option value="DELIVERY">Deliver</option>
            <option value="PICKUP">Pick up</option>
          </select>
        </Field>

        <Field label="Where it needs to go" required>
          <select name="deliveryLocationId" className={inputClass} defaultValue="">
            <option value="" disabled>
              Choose a location…
            </option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Items</h2>
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => setLines((ls) => [...ls, emptyLine(Math.max(0, ...ls.map((l) => l.key)) + 1)])}
          >
            Add item
          </button>
        </div>

        {lines.map((line, idx) => (
          <div key={line.key} className="space-y-3 rounded-md border border-slate-200 p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Line {idx + 1}</span>
              {lines.length > 1 ? (
                <button
                  type="button"
                  className="text-xs text-slate-500 underline"
                  onClick={() => setLines((ls) => ls.filter((l) => l.key !== line.key))}
                >
                  Remove
                </button>
              ) : null}
            </div>
            <Field label="What is needed" required>
              <input
                name="itemDescription"
                className={inputClass}
                value={line.description}
                onChange={(e) => update(line.key, { description: e.target.value })}
                placeholder="e.g. 2x4 LED troffer, 4000K"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Quantity" required>
                <input
                  name="itemQty"
                  className={inputClass}
                  inputMode="decimal"
                  value={line.qty}
                  onChange={(e) => update(line.key, { qty: e.target.value })}
                />
              </Field>
              <Field label="Unit" required>
                <select
                  name="itemUnit"
                  className={inputClass}
                  value={line.unit}
                  onChange={(e) => update(line.key, { unit: e.target.value })}
                >
                  {UNITS.map((u: string) => (
                    <option key={u} value={u}>
                      {u}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Part or stock number" hint="Optional.">
                <input
                  name="itemStockNumber"
                  className={inputClass}
                  value={line.stockNumber}
                  onChange={(e) => update(line.key, { stockNumber: e.target.value })}
                />
              </Field>
              <Field label="Line notes" hint="Optional.">
                <input
                  name="itemNotes"
                  className={inputClass}
                  value={line.notes}
                  onChange={(e) => update(line.key, { notes: e.target.value })}
                />
              </Field>
            </div>
          </div>
        ))}
      </div>

      <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <Field label="Why it is needed" required>
          <textarea name="reason" rows={2} className={inputClass} placeholder="e.g. Fixture rough-in on the second floor." />
        </Field>
        <Field label="Anything else the workshop should know">
          <textarea name="notes" rows={2} className={inputClass} />
        </Field>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="submit" name="submit" value="now" className={buttonClass} disabled={pending}>
          {pending ? 'Sending…' : 'Submit to workshop'}
        </button>
        <button type="submit" name="submit" value="draft" className={secondaryButtonClass} disabled={pending}>
          Save as draft
        </button>
      </div>
    </form>
  );
}

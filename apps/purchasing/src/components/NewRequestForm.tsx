'use client';
/* eslint-disable @typescript-eslint/no-explicit-any */
// ---------------------------------------------------------------------------
// Screen 03 — New Request.
//
// Built thumb-first: one column, large targets, no horizontal scrolling. Speed
// matters more than completeness here — a foreman raises this standing in a
// parking lot, and every field they do not need is a field that slows them
// down.
//
// TWO THINGS THE HANDOFF ASKS FOR THAT THIS FORM DOES DIFFERENTLY, ON PURPOSE:
//
// PRIORITY. The spec asks for Normal / Urgent / Emergency. The domain has no
// priority field — `priority` is in REQUESTOR_FORBIDDEN_FIELDS because the
// specification it implements replaced a self-declared flag with a need-by
// date and time, on the grounds that everybody's request is urgent and nobody's
// date is negotiable. So priority is shown here, live, DERIVED from the date
// the requester picks. They still control it; they control it by saying when
// they need the material, which is the thing the workshop can actually act on.
//
// PREFERRED VENDOR. `vendor_id` is also a forbidden field: choosing the
// supplier is the workshop's decision, and a requester writing it would be
// making a purchasing decision by the back door. The field below captures the
// requester's SUGGESTION as text on the request's notes, clearly attributed.
// The workshop still chooses.
import { useActionState, useState } from 'react';

import { createRequestAction } from '../app/actions.ts';
import { UNITS } from '../purchasing/domain/numbers.mjs';
import {
  Alert,
  Badge,
  Button,
  ButtonRow,
  Field,
  FileUpload,
  Panel,
  SelectInput,
  TextArea,
  TextInput,
  URGENCY_LABELS,
  urgencyOf,
  urgencyTone,
} from './pcc';
import { MaterialSearch } from './pcc/MaterialSearch';

type Line = {
  key: number;
  description: string;
  qty: string;
  unit: string;
  stockNumber: string;
  notes: string;
};

const emptyLine = (key: number): Line => ({
  key,
  description: '',
  qty: '',
  unit: 'ea',
  stockNumber: '',
  notes: '',
});

export default function NewRequestForm({
  actorName,
  locations,
  jobs,
  vendors = [],
  now,
}: {
  actorName: string;
  locations: Array<{ id: string; name: string; kind: string }>;
  jobs: Array<{ number: string; name: string }>;
  vendors?: Array<{ id: string; name: string }>;
  now: string;
}) {
  const [state, formAction, pending] = useActionState(createRequestAction, null as any);
  const [lines, setLines] = useState<Line[]>([emptyLine(1)]);
  const [needByDate, setNeedByDate] = useState('');
  const [needByTime, setNeedByTime] = useState('');

  const update = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const errors: Array<{ field: string; message: string }> = state?.details ?? [];
  const errorFor = (field: string) =>
    errors.find((e) => e.field === field || e.field.startsWith(field))?.message;

  // The derived priority, recomputed as the requester picks a date.
  const urgency = urgencyOf({ needByDate, needByTime, status: 'DRAFT' }, now);

  return (
    <form action={formAction} className="mx-auto max-w-3xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">New purchase request</h1>
        <p className="mt-1 text-sm text-muted">
          Requested by <strong className="text-ink-soft">{actorName}</strong>. The workshop decides stock, vendor,
          cost and how much to order.
        </p>
      </header>

      {state && state.ok === false ? (
        <Alert tone="danger" title={state.error}>
          {errors.length ? (
            <ul className="mt-1 list-disc pl-5">
              {errors.map((e, i) => (
                <li key={i}>{e.message}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}

      <Panel title="Where and when" bodyClassName="space-y-4 p-4">
        <TextInput
          label="Job number"
          name="jobNumber"
          list="job-numbers"
          required
          hint="One request covers exactly one job (BR-005)."
          error={errorFor('jobNumber')}
          autoComplete="off"
        />
        <datalist id="job-numbers">
          {jobs.map((j) => (
            <option key={j.number} value={j.number}>
              {j.name}
            </option>
          ))}
        </datalist>

        <div className="grid grid-cols-2 gap-3">
          <TextInput
            label="Need-by date"
            type="date"
            name="needByDate"
            required
            value={needByDate}
            onChange={(e) => setNeedByDate(e.target.value)}
            error={errorFor('needByDate')}
          />
          <TextInput
            label="Need-by time"
            type="time"
            name="needByTime"
            required
            value={needByTime}
            onChange={(e) => setNeedByTime(e.target.value)}
            error={errorFor('needByTime')}
          />
        </div>

        {/* Priority, derived. Stated in words, with the reason. */}
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-subtle px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">Priority</span>
          {needByDate ? (
            <Badge tone={urgencyTone(urgency)}>{URGENCY_LABELS[urgency]}</Badge>
          ) : (
            <span className="text-sm text-muted">Pick a date and this sets itself</span>
          )}
          <span className="text-xs text-muted">
            Worked out from when you need it — there is no separate priority to argue about.
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SelectInput label="Delivery or pickup" name="deliveryMethod" defaultValue="DELIVERY" required>
            <option value="DELIVERY">Deliver</option>
            <option value="PICKUP">Pick up</option>
          </SelectInput>

          <SelectInput
            label="Where it needs to go"
            name="deliveryLocationId"
            defaultValue=""
            required
            error={errorFor('deliveryLocationId')}
          >
            <option value="" disabled>
              Choose a location…
            </option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </SelectInput>
        </div>
      </Panel>

      <Panel
        title="Items"
        subtitle="Start typing — anything the company has bought before will offer itself"
        bodyClassName="space-y-3 p-4"
        actions={
          <Button
            type="button"
            variant="secondary"
            onClick={() => setLines((ls) => [...ls, emptyLine(Math.max(0, ...ls.map((l) => l.key)) + 1)])}
          >
            Add item
          </Button>
        }
      >
        {lines.map((line, idx) => (
          <div key={line.key} className="space-y-3 rounded-md border border-line p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted">Line {idx + 1}</span>
              {lines.length > 1 ? (
                <button
                  type="button"
                  className="text-xs text-muted underline underline-offset-2 hover:text-danger"
                  onClick={() => setLines((ls) => ls.filter((l) => l.key !== line.key))}
                >
                  Remove
                </button>
              ) : null}
            </div>

            <Field label="What is needed" htmlFor={`item-${line.key}`} required error={errorFor(`items[${idx}]`)}>
              <MaterialSearch
                id={`item-${line.key}`}
                value={line.description}
                onChange={(description) => update(line.key, { description })}
                onPick={(suggestion) =>
                  update(line.key, {
                    description: suggestion.description,
                    unit: suggestion.unit ?? line.unit,
                    stockNumber: suggestion.catalogNumber ?? line.stockNumber,
                  })
                }
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <TextInput
                label="Quantity"
                name="itemQty"
                required
                inputMode="decimal"
                value={line.qty}
                onChange={(e) => update(line.key, { qty: e.target.value })}
              />
              <SelectInput
                label="Unit"
                name="itemUnit"
                required
                value={line.unit}
                onChange={(e) => update(line.key, { unit: e.target.value })}
              >
                {UNITS.map((u: string) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </SelectInput>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextInput
                label="Part or stock number"
                name="itemStockNumber"
                hint="Optional."
                value={line.stockNumber}
                onChange={(e) => update(line.key, { stockNumber: e.target.value })}
              />
              <TextInput
                label="Line notes"
                name="itemNotes"
                hint="Optional."
                value={line.notes}
                onChange={(e) => update(line.key, { notes: e.target.value })}
              />
            </div>
          </div>
        ))}
      </Panel>

      <Panel title="Context" bodyClassName="space-y-4 p-4">
        <TextArea
          label="Why it is needed"
          name="reason"
          rows={2}
          required
          placeholder="e.g. Fixture rough-in on the second floor."
          error={errorFor('reason')}
        />

        <TextInput
          label="Preferred vendor"
          name="preferredVendor"
          list="vendor-names"
          hint="Optional, and a suggestion only — the workshop chooses the supplier and the price."
        />
        <datalist id="vendor-names">
          {vendors.map((v) => (
            <option key={v.id} value={v.name} />
          ))}
        </datalist>

        <TextArea label="Anything else the workshop should know" name="notes" rows={2} />

        <div>
          <span className="mb-1 block text-xs font-semibold text-ink-soft">Attachments</span>
          <FileUpload
            name="attachments"
            label="Add a photo or document"
            hint="A photo of the nameplate, a spec sheet, a marked-up drawing. Up to 6 files."
          />
        </div>
      </Panel>

      <ButtonRow>
        <Button type="submit" name="submit" value="now" size="l" disabled={pending}>
          {pending ? 'Sending…' : 'Submit to workshop'}
        </Button>
        <Button type="submit" name="submit" value="draft" variant="secondary" size="l" disabled={pending}>
          Save as draft
        </Button>
      </ButtonRow>
      <p className="text-xs text-muted">
        A draft stays yours and goes nowhere until you submit it. A submitted request lands in the purchasing queue
        immediately.
      </p>
    </form>
  );
}

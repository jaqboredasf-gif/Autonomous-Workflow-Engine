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
// WHAT IS ABOVE THE FOLD, AND WHY IT IS ONLY THIS MUCH.
//
// Job · what is needed · how many · when. That is the whole ordinary request,
// and it is the same four things a foreman says on the phone today. Everything
// else this form used to ask for — delivery location, need-by time, part
// number, line notes, request notes, attachments — is still here, one click
// down, because an unusual case has to be reachable. None of it is required to
// keep the work moving, so none of it is in the way.
//
// REMOVED OUTRIGHT: the preferred-vendor box. Choosing the supplier is Mike's
// job, the field is a forbidden requestor field in the domain, and a suggestion
// text box invited the field to do purchasing's work badly.
//
// TWO THINGS THE HANDOFF ASKS FOR THAT THIS FORM DOES DIFFERENTLY, ON PURPOSE:
//
// PRIORITY. There is none, and there is no longer a badge predicting one.
//
// The domain never had a priority field — `priority` is in
// REQUESTOR_FORBIDDEN_FIELDS — and this form used to show a derived one live as
// the date was picked. Mike does not sort by it: nearly everything is for the
// following day, so a three-level scale on every request is three levels of
// nothing. What matters is whether a job has gone PAST its date while still
// needing purchasing, and that is derived on the dashboard from the workflow
// state, not declared here.
//
// PREFERRED VENDOR. `vendor_id` is a forbidden requestor field: choosing the
// supplier is the workshop's decision. This form used to offer a free-text
// "preferred vendor" suggestion anyway; it is gone. Mike chooses, on his own
// screen, from the vendor directory.
import { useActionState, useState } from 'react';

import { createRequestAction } from '../app/actions.ts';
import { UNITS } from '../purchasing/domain/numbers.mjs';
import {
  Alert,
  Button,
  ButtonRow,
  Field,
  FileUpload,
  MoreDetails,
  Panel,
  SelectInput,
  TextArea,
  TextInput,
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
  // START OF THE WORKING DAY, not blank. The domain wants a need-by TIME and
  // the honest answer is almost always "when the crew starts"; asking a foreman
  // to set a clock for that is a question with one answer. It stays editable
  // under More details for the delivery that genuinely has to land at noon.
  const [needByTime, setNeedByTime] = useState('07:00');

  // Where it goes, defaulted rather than asked. Material is for a job, so the
  // job site is the default; an installation with no job-site location falls
  // back to the first one configured. Changed under More details when it is
  // going to the shop instead.
  const defaultLocationId =
    locations.find((l) => l.kind === 'JOBSITE')?.id ?? locations[0]?.id ?? '';

  const update = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const errors: Array<{ field: string; message: string }> = state?.details ?? [];
  const errorFor = (field: string) =>
    errors.find((e) => e.field === field || e.field.startsWith(field))?.message;

  return (
    <form action={formAction} className="mx-auto max-w-3xl space-y-5">
      <header>
        <h1 className="text-2xl font-semibold text-ink">What do you need?</h1>
        <p className="mt-1 text-sm text-muted">
          From <strong className="text-ink-soft">{actorName}</strong>. Mike checks the shelf, picks the supplier and
          decides how much to order — you do not need to.
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

      <Panel title="The request" bodyClassName="space-y-4 p-4">
        <TextInput
          label="Job number"
          name="jobNumber"
          list="job-numbers"
          required
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

        {lines.map((line, idx) => (
          <div key={line.key} className="space-y-3">
            {lines.length > 1 ? (
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted">Item {idx + 1}</span>
                <button
                  type="button"
                  className="text-xs text-muted underline underline-offset-2 hover:text-danger"
                  onClick={() => setLines((ls) => ls.filter((l) => l.key !== line.key))}
                >
                  Remove
                </button>
              </div>
            ) : null}

            {/* Free text, first and largest. Anything the company has bought
                before offers itself as you type; nothing makes you find it. */}
            <Field label="What do you need?" htmlFor={`item-${line.key}`} required error={errorFor(`items[${idx}]`)}>
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

            <div className="grid grid-cols-3 gap-3">
              <TextInput
                label="How many"
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
              <TextInput
                label="Need it by"
                type="date"
                name="needByDate"
                required
                value={needByDate}
                onChange={(e) => setNeedByDate(e.target.value)}
                error={errorFor('needByDate')}
              />
            </div>

            {/* Per-item extras. Named so it is obvious there is nothing here
                you have to fill in. */}
            <MoreDetails label="Part number or a note about this item" hint="optional">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <TextInput
                  label="Part or stock number"
                  name="itemStockNumber"
                  value={line.stockNumber}
                  onChange={(e) => update(line.key, { stockNumber: e.target.value })}
                />
                <TextInput
                  label="Note about this item"
                  name="itemNotes"
                  value={line.notes}
                  onChange={(e) => update(line.key, { notes: e.target.value })}
                />
              </div>
            </MoreDetails>
          </div>
        ))}

        <Button
          type="button"
          variant="secondary"
          onClick={() => setLines((ls) => [...ls, emptyLine(Math.max(0, ...ls.map((l) => l.key)) + 1)])}
        >
          Add another item
        </Button>

      </Panel>

      {/* EVERYTHING THAT IS NOT AN ORDINARY REQUEST, still reachable, out of
          the way. Each control keeps a working default, so submitting without
          ever opening this is a complete and valid request. */}
      <MoreDetails
        label="Delivery, timing, notes and photos"
        hint="only if this one is different from usual"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextInput
            label="Need-by time"
            type="time"
            name="needByTime"
            required
            value={needByTime}
            onChange={(e) => setNeedByTime(e.target.value)}
            hint="Defaults to the start of the working day."
            error={errorFor('needByTime')}
          />
          <SelectInput label="Delivery or pickup" name="deliveryMethod" defaultValue="DELIVERY" required>
            <option value="DELIVERY">Deliver</option>
            <option value="PICKUP">Pick up</option>
          </SelectInput>
        </div>

        <SelectInput
          label="Where it needs to go"
          name="deliveryLocationId"
          defaultValue={defaultLocationId}
          required
          hint="Defaults to the job site."
          error={errorFor('deliveryLocationId')}
        >
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </SelectInput>

        <TextArea
          label="Anything the workshop should know"
          name="reason"
          rows={2}
          placeholder="Only if there is something Mike would not already know."
        />

        <div>
          <span className="mb-1 block text-xs font-semibold text-ink-soft">Photos or documents</span>
          <FileUpload
            name="attachments"
            label="Add a photo or document"
            hint="A photo of the nameplate, a spec sheet, a marked-up drawing. Up to 6 files."
          />
        </div>
      </MoreDetails>

      {/* ONE obvious action. Saving a draft is real but rare, so it is a quiet
          second button rather than an equal choice to make every time. */}
      <ButtonRow>
        <Button type="submit" name="submit" value="now" size="l" disabled={pending}>
          {pending ? 'Sending…' : 'Submit to workshop'}
        </Button>
        <Button type="submit" name="submit" value="draft" variant="ghost" disabled={pending}>
          Save as draft
        </Button>
      </ButtonRow>
      <p className="text-xs text-muted">
        A draft stays yours and goes nowhere until you send it.
      </p>
    </form>
  );
}

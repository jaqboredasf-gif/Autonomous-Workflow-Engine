'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Field, { inputClass, errorInputClass } from '@/components/Field';
import MaterialLineEditor from '@/components/MaterialLineEditor';
import { formatMoney } from '@/lib/format';
import { explainApproval, statusOnSubmit } from '@/lib/status';
import { newLine } from '@/lib/store';
import { usePurchasing } from '@/lib/store-context';
import { parseEstimatedCost, validateRequest, type ValidationResult } from '@/lib/validation';
import { PRIORITIES, type MaterialLine, type Priority } from '@/lib/types';

const EMPTY: ValidationResult = { fieldErrors: {}, lineErrors: {}, ok: true };

export default function NewRequest() {
  const router = useRouter();
  const { state, actor, createRequest } = usePurchasing();

  const [requestorId, setRequestorId] = useState('');
  const [jobId, setJobId] = useState('');
  const [vendorId, setVendorId] = useState('');
  const [priority, setPriority] = useState<Priority>('Standard');
  const [neededBy, setNeededBy] = useState('');
  const [estimatedCost, setEstimatedCost] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<MaterialLine[]>([newLine()]);
  const [result, setResult] = useState<ValidationResult>(EMPTY);
  const [submitted, setSubmitted] = useState(false);

  const job = state.jobs.find((j) => j.id === jobId);

  /**
   * Supplier selection is driven by job location and what the branch carries.
   * The demo surfaces vendors serving the job's region first and explains why,
   * but does not block a different choice — the field often knows better.
   */
  const { suggested, others } = useMemo(() => {
    if (!job) return { suggested: [], others: state.vendors };
    return {
      suggested: state.vendors.filter(
        (v) => v.regions.includes(job.region) || v.regions.includes('Statewide'),
      ),
      others: state.vendors.filter(
        (v) => !v.regions.includes(job.region) && !v.regions.includes('Statewide'),
      ),
    };
  }, [job, state.vendors]);

  const draft = {
    requestorId,
    jobId,
    vendorId,
    priority,
    neededBy,
    estimatedCost,
    notes,
    lines,
  };

  const parsedCost = parseEstimatedCost(estimatedCost);
  const projectedStatus = statusOnSubmit({ estimatedCost: parsedCost, priority }, state.settings);

  function submit(asDraft: boolean) {
    const validation = validateRequest(draft);
    setResult(validation);
    setSubmitted(true);
    if (!validation.ok) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const created = createRequest({
      requestorId,
      jobId,
      vendorId,
      priority,
      neededBy,
      estimatedCost: parsedCost,
      notes,
      lines,
      asDraft,
    });
    router.push(`/requests/${created.id}`);
  }

  const errorCount =
    Object.keys(result.fieldErrors).length + Object.keys(result.lineErrors).length;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900">
            New Purchase Request
          </h1>
          <p className="mt-1 text-sm text-neutral-600">
            One job and one vendor per request. Split the order if you need two suppliers.
          </p>
        </div>
        <Link href="/" className="text-sm font-medium text-neutral-600 hover:text-neutral-900">
          Cancel
        </Link>
      </div>

      {submitted && errorCount > 0 && (
        <div
          role="alert"
          className="mt-6 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          <p className="font-semibold">
            {errorCount} {errorCount === 1 ? 'problem' : 'problems'} to fix before this can be
            submitted.
          </p>
        </div>
      )}

      <form
        className="mt-6 space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit(false);
        }}
        noValidate
      >
        <section className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-neutral-900">Request details</h2>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Requestor" required error={result.fieldErrors.requestorId} htmlFor="requestor">
              <select
                id="requestor"
                value={requestorId}
                onChange={(e) => setRequestorId(e.target.value)}
                className={`${inputClass} ${result.fieldErrors.requestorId ? errorInputClass : ''}`}
              >
                <option value="">Select a requestor…</option>
                {state.requestors.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} — {r.role}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Priority" htmlFor="priority">
              <select
                id="priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
                className={inputClass}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Job number"
              required
              error={result.fieldErrors.jobId}
              hint="Exactly one job per request."
              htmlFor="job"
            >
              <select
                id="job"
                value={jobId}
                onChange={(e) => setJobId(e.target.value)}
                className={`${inputClass} ${result.fieldErrors.jobId ? errorInputClass : ''}`}
              >
                <option value="">Select a job number…</option>
                {state.jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.number}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Job name" hint="Filled in from the job number.">
              <input readOnly value={job?.name ?? ''} placeholder="—" className={`${inputClass} bg-neutral-50 text-neutral-600`} />
            </Field>

            <div className="sm:col-span-2">
              <Field label="Job address / location" hint="Filled in from the job number. Drives the supplier suggestion below.">
                <input
                  readOnly
                  value={job?.address ?? ''}
                  placeholder="—"
                  className={`${inputClass} bg-neutral-50 text-neutral-600`}
                />
              </Field>
            </div>

            <div className="sm:col-span-2">
              <Field
                label="Vendor"
                required
                error={result.fieldErrors.vendorId}
                hint={
                  job
                    ? `Suppliers serving the ${job.region} area are listed first.`
                    : 'Pick a job number first to see the closest suppliers.'
                }
                htmlFor="vendor"
              >
                <select
                  id="vendor"
                  value={vendorId}
                  onChange={(e) => setVendorId(e.target.value)}
                  className={`${inputClass} ${result.fieldErrors.vendorId ? errorInputClass : ''}`}
                >
                  <option value="">Select a vendor…</option>
                  {suggested.length > 0 && (
                    <optgroup label={job ? `Serves ${job.region} area` : 'All suppliers'}>
                      {suggested.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name} — {v.specialty}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {others.length > 0 && (
                    <optgroup label="Other suppliers">
                      {others.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name} — {v.specialty}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </Field>
            </div>

            <Field label="Needed by" htmlFor="neededBy">
              <input
                id="neededBy"
                type="date"
                value={neededBy}
                onChange={(e) => setNeededBy(e.target.value)}
                className={inputClass}
              />
            </Field>

            <Field
              label="Estimated cost"
              error={result.fieldErrors.estimatedCost}
              hint="Requestor's estimate — not a quote."
              htmlFor="estimatedCost"
            >
              <input
                id="estimatedCost"
                type="number"
                min={0}
                step="0.01"
                value={estimatedCost}
                onChange={(e) => setEstimatedCost(e.target.value)}
                placeholder="0.00"
                className={`${inputClass} ${result.fieldErrors.estimatedCost ? errorInputClass : ''}`}
              />
            </Field>

            <div className="sm:col-span-2">
              <Field label="Notes" htmlFor="notes">
                <textarea
                  id="notes"
                  rows={3}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Delivery instructions, who to call on site, substitutions allowed…"
                  className={inputClass}
                />
              </Field>
            </div>
          </div>
        </section>

        <MaterialLineEditor
          lines={lines}
          errors={result.lineErrors}
          listError={result.fieldErrors.lines}
          onChange={setLines}
        />

        <section className="rounded-lg border border-neutral-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-neutral-900">On submit</h2>
          <p className="mt-1 text-sm text-neutral-600">
            This request will go to <strong>{projectedStatus}</strong>.{' '}
            {explainApproval({ estimatedCost: parsedCost, priority }, state.settings)}{' '}
            Estimated cost entered: {formatMoney(parsedCost)}.
          </p>
          <p className="mt-2 text-xs text-neutral-500">
            Submitting records the request in this demo only. It does not contact the supplier.
          </p>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <button
              type="submit"
              className="rounded-md bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800"
            >
              Submit request
            </button>
            <button
              type="button"
              onClick={() => submit(true)}
              className="rounded-md border border-neutral-300 px-4 py-2.5 text-sm font-semibold text-neutral-800 hover:bg-neutral-50"
            >
              Save as draft
            </button>
            <span className="self-center text-xs text-neutral-500 sm:ml-2">
              Acting as {actor}
            </span>
          </div>
        </section>
      </form>
    </main>
  );
}

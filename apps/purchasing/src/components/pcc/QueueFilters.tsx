'use client';
// The queue's filter bar.
//
// A GET form, not a controlled component tree. Every filter ends up in the URL,
// which means a purchasing manager can bookmark "overdue on job 24-118",
// send it to somebody, reload it, and use the back button — none of which a
// useState filter gives you. It also keeps the queue itself a server component
// filtering server-side, so the browser never receives rows it may not see.
//
// The client directive buys exactly one thing: auto-submitting when a select
// changes, so the controls feel immediate. Without JavaScript the Apply button
// does the same job.
import { useRef } from 'react';

import { buttonStyle } from './Button';
import { fieldStyle } from './Input';

export type FilterOption = { value: string; label: string };

export function QueueFilters({
  action,
  values,
  statuses,
  jobs,
  vendors,
  requesters,
  hidden = {},
}: {
  action: string;
  values: Record<string, string>;
  statuses: FilterOption[];
  jobs: FilterOption[];
  vendors: FilterOption[];
  requesters: FilterOption[];
  /** Values carried through the form without being editable (the stage tab). */
  hidden?: Record<string, string>;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const submit = () => formRef.current?.requestSubmit();

  const active = Object.entries(values).filter(([, v]) => v).length;

  return (
    <form ref={formRef} action={action} method="get" className="rounded-lg border border-line bg-surface p-3 shadow-card">
      {Object.entries(hidden).map(([name, value]) =>
        value ? <input key={name} type="hidden" name={name} value={value} /> : null,
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="relative lg:col-span-2">
          <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="9" cy="9" r="6" />
              <path d="m14 14 4 4" strokeLinecap="round" />
            </svg>
          </span>
          <input
            name="search"
            type="search"
            defaultValue={values.search ?? ''}
            placeholder="Search request, PO, job, vendor, tracking…"
            aria-label="Search the queue"
            className={fieldStyle({ className: 'pl-9' })}
          />
        </div>

        <select
          name="status"
          defaultValue={values.status ?? ''}
          onChange={submit}
          aria-label="Filter by status"
          className={fieldStyle()}
        >
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        <select
          name="jobNumber"
          defaultValue={values.jobNumber ?? ''}
          onChange={submit}
          aria-label="Filter by job"
          className={fieldStyle()}
        >
          <option value="">All jobs</option>
          {jobs.map((j) => (
            <option key={j.value} value={j.value}>
              {j.label}
            </option>
          ))}
        </select>

        <select
          name="vendorId"
          defaultValue={values.vendorId ?? ''}
          onChange={submit}
          aria-label="Filter by vendor"
          className={fieldStyle()}
        >
          <option value="">All vendors</option>
          {vendors.map((v) => (
            <option key={v.value} value={v.value}>
              {v.label}
            </option>
          ))}
        </select>

        <select
          name="requestorId"
          defaultValue={values.requestorId ?? ''}
          onChange={submit}
          aria-label="Filter by requester"
          className={fieldStyle()}
        >
          <option value="">All requesters</option>
          {requesters.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-2">
          <label className="flex-1">
            <span className="sr-only">Need-by from</span>
            <input
              type="date"
              name="needByFrom"
              defaultValue={values.needByFrom ?? ''}
              aria-label="Need-by from"
              className={fieldStyle()}
            />
          </label>
          <label className="flex-1">
            <span className="sr-only">Need-by to</span>
            <input
              type="date"
              name="needByTo"
              defaultValue={values.needByTo ?? ''}
              aria-label="Need-by to"
              className={fieldStyle()}
            />
          </label>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <label className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-ink-soft">
          <input
            type="checkbox"
            name="overdue"
            value="1"
            defaultChecked={values.overdue === '1'}
            onChange={submit}
            className="h-4 w-4 rounded border-line-strong text-action focus:ring-action"
          />
          Overdue only
        </label>

        <button type="submit" className={buttonStyle('primary', 'm')}>
          Apply
        </button>

        {/* A plain link, so clearing cannot be defeated by a sticky default. */}
        <a href={action} className={buttonStyle('ghost', 'm')}>
          Clear filters{active ? ` (${active})` : ''}
        </a>
      </div>
    </form>
  );
}

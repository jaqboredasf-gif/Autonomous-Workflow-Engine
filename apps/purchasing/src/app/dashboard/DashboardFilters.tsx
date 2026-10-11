'use client';
// The dashboard's filter bar.
//
// Same arrangement as the queue's QueueFilters, deliberately: a GET form whose
// state lives in the URL, so "overdue on job 24-118" is a link somebody can
// bookmark, reload, send to a colleague, or back out of. The page stays a
// server component and filters server-side, so the browser is never handed rows
// the viewer may not see.
//
// Narrower than the queue's bar on purpose. The dashboard is a place to take a
// reading, not to run a search; four controls cover "this job", "this vendor",
// "this word" and "only what is late". Anything more specific belongs in the
// queue, and the header links there.
import { useRef } from 'react';

import { buttonStyle, fieldStyle } from '../../components/pcc';

export type FilterOption = { value: string; label: string };

export function DashboardFilters({
  values,
  jobs,
  vendors,
}: {
  values: { search: string; jobNumber: string; vendorId: string; overdue: boolean };
  jobs: FilterOption[];
  vendors: FilterOption[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const submit = () => formRef.current?.requestSubmit();

  const active =
    (values.search ? 1 : 0) + (values.jobNumber ? 1 : 0) + (values.vendorId ? 1 : 0) + (values.overdue ? 1 : 0);

  return (
    <form
      ref={formRef}
      action="/dashboard"
      method="get"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-2.5 shadow-card"
    >
      <div className="relative min-w-0 flex-1 basis-64">
        <span aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="9" cy="9" r="6" />
            <path d="m14 14 4 4" strokeLinecap="round" />
          </svg>
        </span>
        <input
          name="search"
          type="search"
          defaultValue={values.search}
          placeholder="Search request, PO, job, vendor, tracking…"
          aria-label="Search purchasing"
          className={fieldStyle({ className: 'pl-9' })}
        />
      </div>

      <select
        name="jobNumber"
        defaultValue={values.jobNumber}
        onChange={submit}
        aria-label="Filter by job"
        className={fieldStyle({ className: 'w-auto min-w-40' })}
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
        defaultValue={values.vendorId}
        onChange={submit}
        aria-label="Filter by vendor"
        className={fieldStyle({ className: 'w-auto min-w-40' })}
      >
        <option value="">All vendors</option>
        {vendors.map((v) => (
          <option key={v.value} value={v.value}>
            {v.label}
          </option>
        ))}
      </select>

      <label className="flex min-h-10 cursor-pointer items-center gap-2 whitespace-nowrap px-1 text-sm text-ink-soft">
        <input
          type="checkbox"
          name="overdue"
          value="1"
          defaultChecked={values.overdue}
          onChange={submit}
          className="h-4 w-4 rounded border-line-strong text-action focus:ring-action"
        />
        Overdue only
      </label>

      <button type="submit" className={buttonStyle('primary', 'm')}>
        Apply
      </button>

      {/* A plain link, so clearing cannot be defeated by a sticky default. */}
      {active ? (
        <a href="/dashboard" className={buttonStyle('ghost', 'm')}>
          Clear ({active})
        </a>
      ) : null}
    </form>
  );
}

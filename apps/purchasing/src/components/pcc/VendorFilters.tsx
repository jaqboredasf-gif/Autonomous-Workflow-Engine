'use client';
// Filter bar for the vendor and material directories.
//
// Same shape as the queue's: a GET form, so the filtered view is a URL. The
// client directive only buys the auto-submit on the select.
import { useRef } from 'react';

import { buttonStyle } from './Button';
import { fieldStyle } from './Input';

export function VendorFilters({
  action,
  values,
  placeholder = 'Search name, account number, contact…',
  extra,
}: {
  action: string;
  values: { search: string; active: string };
  placeholder?: string;
  extra?: React.ReactNode;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={action}
      method="get"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-3 shadow-card"
    >
      <div className="relative min-w-56 flex-1">
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
          placeholder={placeholder}
          aria-label="Search"
          className={fieldStyle({ className: 'pl-9' })}
        />
      </div>

      <select
        name="active"
        defaultValue={values.active}
        onChange={() => formRef.current?.requestSubmit()}
        aria-label="Show active or inactive"
        className={fieldStyle({ className: 'w-auto' })}
      >
        <option value="active">Active</option>
        <option value="inactive">Inactive</option>
      </select>

      {extra}

      <button type="submit" className={buttonStyle('primary', 'm')}>
        Search
      </button>
      <a href={action} className={buttonStyle('ghost', 'm')}>
        Clear
      </a>
    </form>
  );
}

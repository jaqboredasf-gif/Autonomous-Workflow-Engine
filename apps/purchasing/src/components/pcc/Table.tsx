// Data table primitives.
//
// Not a table *component*: a set of parts. Every operational screen has
// different columns and different row actions, and a configurable mega-table
// ends up harder to read than the markup it replaces. What is shared — the
// scroll container, the sticky header, the cell rhythm, the empty and loading
// bodies — lives here.
import Link from 'next/link';

/**
 * The scroll container. Wide operational tables scroll INSIDE this, so the
 * page body never scrolls sideways on a narrow screen.
 */
export function TableFrame({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`overflow-x-auto rounded-lg border border-line bg-surface shadow-card ${className}`}>
      {children}
    </div>
  );
}

export function Table({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <table className={`min-w-full border-collapse text-left text-sm ${className}`}>{children}</table>;
}

/**
 * Sticky header. `sticky` is on the cells rather than the row because a
 * <thead> cannot be a positioning context in every browser.
 */
export function THead({ children, sticky = true }: { children: React.ReactNode; sticky?: boolean }) {
  return (
    <thead
      className={`bg-subtle text-xs font-semibold uppercase tracking-wide text-muted ${
        sticky ? '[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-subtle' : ''
      }`}
    >
      {children}
    </thead>
  );
}

export function TH({
  children,
  align = 'left',
  className = '',
  ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' | 'center' }) {
  return (
    <th
      scope="col"
      {...props}
      className={`whitespace-nowrap border-b border-line px-3 py-2 font-semibold ${
        align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'
      } ${className}`}
    >
      {children}
    </th>
  );
}

export function TBody({ children }: { children: React.ReactNode }) {
  return <tbody className="divide-y divide-line">{children}</tbody>;
}

export function TR({
  children,
  highlight = false,
  className = '',
  ...props
}: React.HTMLAttributes<HTMLTableRowElement> & { highlight?: boolean }) {
  return (
    <tr {...props} className={`transition hover:bg-action-soft/60 ${highlight ? 'bg-danger-bg' : ''} ${className}`}>
      {children}
    </tr>
  );
}

export function TD({
  children,
  align = 'left',
  numeric = false,
  className = '',
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { align?: 'left' | 'right' | 'center'; numeric?: boolean }) {
  return (
    <td
      {...props}
      className={`px-3 py-2 align-middle text-ink-soft ${
        align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : ''
      } ${numeric ? 'tabular-nums' : ''} ${className}`}
    >
      {children}
    </td>
  );
}

/** The primary identifier cell — the thing you click to open the record. */
export function TDLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <TD className="font-medium">
      <Link href={href} className="text-action underline-offset-2 hover:underline">
        {children}
      </Link>
    </TD>
  );
}

export function TableEmpty({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-10 text-center text-sm text-muted">
        {children}
      </td>
    </tr>
  );
}

/** Skeleton rows, for a table whose data has not arrived yet. */
export function TableSkeleton({ colSpan, rows = 5 }: { colSpan: number; rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i} aria-hidden="true">
          <td colSpan={colSpan} className="px-3 py-3">
            <div className="h-4 animate-pulse rounded bg-subtle" />
          </td>
        </tr>
      ))}
    </>
  );
}

/** A caption line under a table: "12 of 48 requests". */
export function TableCount({ shown, total, noun }: { shown: number; total: number; noun: string }) {
  return (
    <p className="mt-2 text-xs text-muted" role="status">
      Showing {shown} of {total} {noun}
      {shown !== total ? ' — filters are applied' : ''}
    </p>
  );
}

// Surfaces: the plain card, the titled panel, and the KPI tile.
import Link from 'next/link';

import type { Tone } from './status-display';

export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div className={`rounded-lg border border-line bg-surface shadow-card ${padded ? 'p-4' : ''} ${className}`}>
      {children}
    </div>
  );
}

/**
 * A titled region with an optional action slot in its header. This is the
 * workhorse container for every screen section.
 */
export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = '',
  bodyClassName = 'p-4',
  headingLevel = 2,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return (
    <section className={`overflow-hidden rounded-lg border border-line bg-surface shadow-card ${className}`}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <Heading className="text-base font-semibold text-ink">{title}</Heading>
          {subtitle ? <p className="mt-0.5 text-xs text-muted">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </header>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

const KPI_TONES: Record<Tone, string> = {
  neutral: 'text-ink',
  info: 'text-info',
  attention: 'text-action',
  warn: 'text-warning',
  good: 'text-success',
  bad: 'text-danger',
};

/**
 * A KPI tile. `href` makes the whole tile a link to the filtered list it
 * counts — the number is only useful if you can open what is behind it.
 */
export function KpiCard({
  label,
  value,
  hint,
  href,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
  tone?: Tone;
}) {
  const body = (
    <div className="h-full rounded-lg border border-line bg-surface p-4 shadow-card transition group-hover:border-action-hover">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-3xl font-bold leading-10 tabular-nums ${KPI_TONES[tone]}`}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </div>
  );
  return href ? (
    <Link href={href} className="group block focus-visible:rounded-lg">
      {body}
    </Link>
  ) : (
    body
  );
}

/** A labelled read-only value. The unit of every detail header. */
export function DataPoint({
  label,
  children,
  className = '',
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children || <span className="text-muted">—</span>}</dd>
    </div>
  );
}

/** A responsive grid of DataPoints for a detail header. */
export function DataGrid({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <dl className={`grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-4 ${className}`}>{children}</dl>
  );
}

// Feedback: alerts, empty states, skeletons, page headings, breadcrumbs.
//
// There is deliberately no toast. This application's mutations are server
// actions that re-render the page, so a message that fades out after three
// seconds would be the ONLY record of what happened to a purchase order. The
// handoff allows a toast "if the app architecture supports it"; this
// architecture supports something better, which is an alert that stays on the
// surface it belongs to.
import Link from 'next/link';

import type { Tone } from './status-display';

const ALERT_TONES: Record<string, { box: string; icon: string; label: string }> = {
  info: { box: 'border-info/30 bg-info-bg text-ink-soft', icon: 'text-info', label: 'Note' },
  success: { box: 'border-success/30 bg-success-bg text-ink-soft', icon: 'text-success', label: 'Done' },
  warning: { box: 'border-warning/40 bg-warning-bg text-ink-soft', icon: 'text-warning', label: 'Careful' },
  danger: { box: 'border-danger/40 bg-danger-bg text-ink-soft', icon: 'text-danger', label: 'Problem' },
};

export function Alert({
  tone = 'info',
  title,
  children,
  actions,
  className = '',
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: React.ReactNode;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  const t = ALERT_TONES[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={`rounded-lg border px-4 py-3 text-sm ${t.box} ${className}`}
    >
      <div className="flex gap-3">
        <span aria-hidden="true" className={`mt-0.5 shrink-0 ${t.icon}`}>
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
            <circle cx="10" cy="10" r="9" opacity="0.15" />
            <path d="M10 5.5a1 1 0 0 1 1 1v4a1 1 0 1 1-2 0v-4a1 1 0 0 1 1-1Zm0 8.25a1.15 1.15 0 1 1 0 2.3 1.15 1.15 0 0 1 0-2.3Z" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          {/* The tone is named in text, not only shown in colour. */}
          {title ? <p className="font-semibold text-ink">{title}</p> : null}
          {children ? <div className={title ? 'mt-1' : ''}>{children}</div> : null}
          {actions ? <div className="mt-3 flex flex-wrap gap-2">{actions}</div> : null}
        </div>
      </div>
    </div>
  );
}

/** Inline validation text under a control that manages its own layout. */
export function InlineError({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="mt-1 text-xs font-medium text-danger">
      {children}
    </p>
  );
}

export function EmptyState({
  title,
  description,
  action,
  className = '',
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-lg px-6 py-12 text-center ${className}`}>
      <p className="text-sm font-semibold text-ink">{title}</p>
      {description ? <p className="mt-1 max-w-md text-sm text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded bg-subtle ${className}`} />;
}

/** A whole card's worth of skeleton, for route-level loading.tsx files. */
export function CardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface p-4 shadow-card">
      <Skeleton className="h-5 w-40" />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-4 w-full" />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export function Breadcrumb({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex flex-wrap items-center gap-1 text-xs text-muted">
        {items.map((item, i) => (
          <li key={`${item.label}-${i}`} className="flex items-center gap-1">
            {i > 0 ? (
              <span aria-hidden="true" className="text-line-strong">
                /
              </span>
            ) : null}
            {item.href && i < items.length - 1 ? (
              <Link href={item.href} className="hover:text-ink">
                {item.label}
              </Link>
            ) : (
              <span className={i === items.length - 1 ? 'font-medium text-ink-soft' : ''} aria-current={i === items.length - 1 ? 'page' : undefined}>
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * The page heading pattern every screen uses: breadcrumb, title, one line of
 * context, and the screen's primary actions.
 */
export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
  meta,
  className = '',
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  breadcrumb?: Array<{ label: string; href?: string }>;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={`flex flex-wrap items-start justify-between gap-3 ${className}`}>
      <div className="min-w-0">
        {breadcrumb ? <Breadcrumb items={breadcrumb} /> : null}
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold leading-8 text-ink">{title}</h1>
          {meta}
        </div>
        {description ? <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A tone dot with its meaning in text beside it. Never a dot alone. */
export function ToneLabel({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const colour: Record<Tone, string> = {
    neutral: 'bg-line-strong',
    info: 'bg-info',
    attention: 'bg-action',
    warn: 'bg-warning',
    good: 'bg-success',
    bad: 'bg-danger',
  };
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-ink-soft">
      <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${colour[tone]}`} />
      {children}
    </span>
  );
}

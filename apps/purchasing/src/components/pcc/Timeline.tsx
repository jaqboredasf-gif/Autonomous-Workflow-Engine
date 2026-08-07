/* eslint-disable @typescript-eslint/no-explicit-any */
// Timeline and activity feed.
//
// Reads the recorded rows — it never reconstructs a history from current
// state, because the point of an audit trail is that it says what happened
// even when the current state disagrees. `buildTimeline()` is the domain's,
// so the ordering and the wording are the same everywhere they appear.
import Link from 'next/link';

import { buildTimeline } from '../../purchasing/domain/activity.mjs';
import { EmptyState } from './Feedback';

export function Timeline({ entries }: { entries: any[] }) {
  const rows = buildTimeline(entries);
  if (rows.length === 0) {
    return <EmptyState title="Nothing recorded yet" description="Actions on this record appear here as they happen." />;
  }

  return (
    <ol className="relative space-y-0">
      {rows.map((row: any, i: number) => (
        <li key={row.id} className="relative flex gap-3 pb-5 last:pb-0">
          {/* The rail. Drawn per item so the last entry does not trail a line
              into empty space. */}
          {i < rows.length - 1 ? (
            <span aria-hidden="true" className="absolute left-[5px] top-3 h-full w-px bg-line" />
          ) : null}
          <span aria-hidden="true" className="relative mt-1.5 h-[11px] w-[11px] shrink-0 rounded-full border-2 border-action bg-surface" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium text-ink">{row.description}</span>
              <time className="text-xs text-muted">{formatStamp(row.at)}</time>
            </div>
            {row.notes ? <p className="mt-0.5 text-sm text-ink-soft">“{row.notes}”</p> : null}
            {row.changes.length ? (
              <ul className="mt-1 space-y-0.5 text-xs text-muted">
                {row.changes.map((c: any, j: number) => (
                  <li key={j}>
                    <span className="font-medium text-ink-soft">{c.field}</span>: {render(c.from)} → {render(c.to)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * One line in a cross-record activity feed (the dashboard). Same data as the
 * timeline, laid out for scanning rather than for reading one record's story.
 */
export function ActivityItem({
  description,
  at,
  actor,
  href,
}: {
  description: string;
  at: string;
  actor?: string | null;
  href?: string | null;
}) {
  const body = (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-2.5">
      <span className="min-w-0 text-sm text-ink">{description}</span>
      <span className="whitespace-nowrap text-xs text-muted">
        {actor ? `${actor} · ` : ''}
        {formatStamp(at)}
      </span>
    </div>
  );
  return (
    <li className="border-b border-line last:border-0">
      {href ? (
        <Link href={href} className="block transition hover:bg-action-soft/60">
          {body}
        </Link>
      ) : (
        body
      )}
    </li>
  );
}

export function ActivityFeed({ children }: { children: React.ReactNode }) {
  return <ul className="divide-y-0">{children}</ul>;
}

function render(v: unknown) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function formatStamp(at: string) {
  return String(at).replace('T', ' ').slice(0, 16);
}

export default Timeline;

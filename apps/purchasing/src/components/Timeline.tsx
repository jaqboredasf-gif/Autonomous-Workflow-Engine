/* eslint-disable @typescript-eslint/no-explicit-any */
// The activity timeline. Reads the recorded rows — it never reconstructs a
// history from current state, because the point of an audit trail is that it
// says what happened even when the current state disagrees.
import { buildTimeline } from '../domain/activity.mjs';

export default function Timeline({ entries }: { entries: any[] }) {
  const rows = buildTimeline(entries);
  if (rows.length === 0) return <p className="text-sm text-slate-500">Nothing recorded yet.</p>;

  return (
    <ol className="space-y-3">
      {rows.map((row: any) => (
        <li key={row.id} className="border-l-2 border-slate-200 pl-3">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm text-slate-900">{row.description}</span>
            <span className="text-xs text-slate-500">{formatStamp(row.at)}</span>
          </div>
          {row.notes ? <p className="mt-0.5 text-xs text-slate-600">“{row.notes}”</p> : null}
          {row.changes.length ? (
            <ul className="mt-1 space-y-0.5 text-xs text-slate-500">
              {row.changes.map((c: any, i: number) => (
                <li key={i}>
                  <span className="font-medium">{c.field}</span>: {render(c.from)} → {render(c.to)}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function render(v: unknown) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function formatStamp(at: string) {
  return String(at).replace('T', ' ').slice(0, 16);
}

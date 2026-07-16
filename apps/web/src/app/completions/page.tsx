'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Row {
  id: string;
  completed_at: string;
  work_complete: boolean;
  return_trip_needed: boolean;
  return_trip_reason: string | null;
  materials_used: string | null;
  notes: string | null;
  users: { full_name: string } | null;
  job_sites: { name: string } | null;
}

export default function Completions() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const from = new Date(Date.now() - 30 * 864e5).toISOString();
    supabase
      .from('completion_reports')
      .select(
        'id, completed_at, work_complete, return_trip_needed, return_trip_reason, materials_used, notes, users!completion_reports_user_id_fkey(full_name), job_sites(name)'
      )
      .gte('completed_at', from)
      .order('completed_at', { ascending: false })
      .overrideTypes<Row[]>()
      .then(({ data, error }) => {
        if (error) setError(error.message + ' — sign in on the Home page.');
        setRows(data ?? []);
      });
  }, []);

  if (error) return <main className="p-8 text-red-600">{error}</main>;
  if (!rows) return <main className="p-8">Loading…</main>;

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-bold">Job Completions — last 30 days</h1>
      {rows.length === 0 ? (
        <p className="mt-6 text-neutral-500">No completion reports yet.</p>
      ) : (
        <div className="mt-6 space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="rounded border p-4">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <strong>{r.users?.full_name ?? '?'}</strong>
                <span className="text-neutral-500">· {r.job_sites?.name ?? 'no site'}</span>
                <span className="text-neutral-500">· {new Date(r.completed_at).toLocaleString()}</span>
                <span className={`rounded px-2 py-0.5 text-xs ${
                  r.work_complete ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'
                }`}>
                  {r.work_complete ? 'complete' : 'incomplete'}
                </span>
                {r.return_trip_needed && (
                  <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">
                    return trip{r.return_trip_reason ? `: ${r.return_trip_reason}` : ''}
                  </span>
                )}
              </div>
              {r.materials_used && (
                <p className="mt-2 text-sm"><span className="text-neutral-500">Materials:</span> {r.materials_used}</p>
              )}
              {r.notes && <p className="mt-1 text-sm">{r.notes}</p>}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

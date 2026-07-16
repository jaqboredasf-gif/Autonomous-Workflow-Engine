'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Row {
  id: string;
  clock_in: string;
  clock_out: string | null;
  status: string;
  in_geo_flag: 'inside' | 'outside' | 'no_gps';
  out_geo_flag: 'inside' | 'outside' | 'no_gps' | null;
  users: { full_name: string } | null;
  job_sites: { name: string } | null;
  cost_codes: { code: string } | null;
}

const FLAG_STYLE: Record<string, string> = {
  inside: 'text-green-600',
  outside: 'text-red-600 font-semibold',
  no_gps: 'text-amber-600',
};

function hours(row: Row): string {
  if (!row.clock_out) return '—';
  const ms = new Date(row.clock_out).getTime() - new Date(row.clock_in).getTime();
  return (ms / 3_600_000).toFixed(2);
}

function fmt(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function Timesheets() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const from = new Date();
    from.setDate(from.getDate() - 7);
    supabase
      .from('time_entries')
      .select(
        'id, clock_in, clock_out, status, in_geo_flag, out_geo_flag, users!time_entries_user_id_fkey(full_name), job_sites(name), cost_codes(code)'
      )
      .gte('clock_in', from.toISOString())
      .order('clock_in', { ascending: false })
      .overrideTypes<Row[]>()
      .then(({ data, error }) => {
        if (error) setError(error.message);
        setRows(data ?? []);
      });
  }, []);

  if (error) return <main className="p-8 text-red-600">{error}</main>;
  if (!rows) return <main className="p-8">Loading…</main>;

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-bold">Timesheets — last 7 days</h1>
      {rows.length === 0 ? (
        <p className="mt-6 text-neutral-500">No entries. Sign in on the home page first.</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-neutral-500">
                <th className="py-2 pr-4">Employee</th>
                <th className="py-2 pr-4">Site</th>
                <th className="py-2 pr-4">Code</th>
                <th className="py-2 pr-4">In</th>
                <th className="py-2 pr-4">Out</th>
                <th className="py-2 pr-4">Hours</th>
                <th className="py-2 pr-4">GPS</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b">
                  <td className="py-2 pr-4">{r.users?.full_name ?? '?'}</td>
                  <td className="py-2 pr-4">{r.job_sites?.name ?? '—'}</td>
                  <td className="py-2 pr-4">{r.cost_codes?.code ?? '—'}</td>
                  <td className="py-2 pr-4">{fmt(r.clock_in)}</td>
                  <td className="py-2 pr-4">{fmt(r.clock_out)}</td>
                  <td className="py-2 pr-4">{hours(r)}</td>
                  <td className="py-2 pr-4">
                    <span className={FLAG_STYLE[r.in_geo_flag]}>{r.in_geo_flag}</span>
                    {' / '}
                    <span className={r.out_geo_flag ? FLAG_STYLE[r.out_geo_flag] : ''}>
                      {r.out_geo_flag ?? '—'}
                    </span>
                  </td>
                  <td className="py-2">{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

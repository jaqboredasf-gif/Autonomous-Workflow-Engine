'use client';

// Payroll layout + draft math. Marked DRAFT until the full policy is
// confirmed in writing (see docs/ROADMAP.md Phase 3). Rules come from
// org_settings — currently: unpaid lunch 12:00–12:30 auto-deducted.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Entry {
  user_id: string;
  clock_in: string;
  clock_out: string | null;
  users: { full_name: string } | null;
}

interface Settings {
  lunch_start: string;
  lunch_end: string;
  lunch_paid: boolean;
  lunch_auto_deduct: boolean;
  rounding_minutes: number;
}

interface Summary {
  name: string;
  entries: number;
  rawHours: number;
  lunchDeducted: number;
  payableHours: number;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Minutes of overlap between [in,out] and the lunch window on each day spanned. */
function lunchOverlapMin(inTs: Date, outTs: Date, s: Settings): number {
  const [lsH, lsM] = s.lunch_start.split(':').map(Number);
  const [leH, leM] = s.lunch_end.split(':').map(Number);
  let total = 0;
  const day = new Date(inTs);
  day.setHours(0, 0, 0, 0);
  while (day <= outTs) {
    const ls = new Date(day);
    ls.setHours(lsH, lsM, 0, 0);
    const le = new Date(day);
    le.setHours(leH, leM, 0, 0);
    const start = Math.max(inTs.getTime(), ls.getTime());
    const end = Math.min(outTs.getTime(), le.getTime());
    if (end > start) total += (end - start) / 60000;
    day.setDate(day.getDate() + 1);
  }
  return total;
}

export default function Payroll() {
  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 6);
  const [from, setFrom] = useState(isoDate(weekAgo));
  const [to, setTo] = useState(isoDate(today));
  const [rows, setRows] = useState<Summary[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setError(null);
    const [{ data: s }, { data: entries, error: err }] = await Promise.all([
      supabase.from('org_settings').select('*').single(),
      supabase
        .from('time_entries')
        .select('user_id, clock_in, clock_out, users!time_entries_user_id_fkey(full_name)')
        .gte('clock_in', `${from}T00:00:00Z`)
        .lte('clock_in', `${to}T23:59:59Z`)
        .overrideTypes<Entry[]>(),
    ]);
    if (err) {
      setError(err.message);
      return;
    }
    setSettings(s);
    const byUser = new Map<string, Summary>();
    for (const e of entries ?? []) {
      if (!e.clock_out) continue;
      const inTs = new Date(e.clock_in);
      const outTs = new Date(e.clock_out);
      const raw = (outTs.getTime() - inTs.getTime()) / 3_600_000;
      const deductH =
        s && s.lunch_auto_deduct && !s.lunch_paid ? lunchOverlapMin(inTs, outTs, s) / 60 : 0;
      const cur = byUser.get(e.user_id) ?? {
        name: e.users?.full_name ?? '?',
        entries: 0,
        rawHours: 0,
        lunchDeducted: 0,
        payableHours: 0,
      };
      cur.entries += 1;
      cur.rawHours += raw;
      cur.lunchDeducted += deductH;
      cur.payableHours += raw - deductH;
      byUser.set(e.user_id, cur);
    }
    setRows([...byUser.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function downloadCsv() {
    if (!rows) return;
    const lines = [
      'employee,entries,raw_hours,lunch_deducted_hours,payable_hours',
      ...rows.map(
        (r) =>
          `"${r.name}",${r.entries},${r.rawHours.toFixed(2)},${r.lunchDeducted.toFixed(2)},${r.payableHours.toFixed(2)}`
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `payroll-${from}-to-${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-bold">
        Payroll <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-700 align-middle">DRAFT MATH</span>
      </h1>
      <p className="mt-2 text-sm text-neutral-500">
        Draft until full policy confirmed. Current rules: lunch{' '}
        {settings ? `${settings.lunch_start.slice(0, 5)}–${settings.lunch_end.slice(0, 5)}` : '…'}{' '}
        {settings?.lunch_paid ? '(paid)' : '(unpaid, auto-deducted)'} · OT + rounding not yet applied.
      </p>

      <div className="mt-4 flex items-end gap-3">
        <label className="text-sm">
          From
          <input type="date" className="mt-1 block rounded border px-2 py-1.5 text-sm" value={from}
            onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-sm">
          To
          <input type="date" className="mt-1 block rounded border px-2 py-1.5 text-sm" value={to}
            onChange={(e) => setTo(e.target.value)} />
        </label>
        <button onClick={run} className="rounded bg-blue-600 px-3 py-2 text-sm text-white">
          Run
        </button>
        <button onClick={downloadCsv} disabled={!rows?.length}
          className="rounded bg-neutral-800 px-3 py-2 text-sm text-white disabled:opacity-40">
          Download CSV
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {rows && (
        <table className="mt-6 w-full text-sm">
          <thead>
            <tr className="border-b text-left text-neutral-500">
              <th className="py-2 pr-4">Employee</th>
              <th className="py-2 pr-4">Entries</th>
              <th className="py-2 pr-4">Raw hours</th>
              <th className="py-2 pr-4">Lunch deducted</th>
              <th className="py-2">Payable hours</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-b">
                <td className="py-2 pr-4">{r.name}</td>
                <td className="py-2 pr-4">{r.entries}</td>
                <td className="py-2 pr-4">{r.rawHours.toFixed(2)}</td>
                <td className="py-2 pr-4">{r.lunchDeducted.toFixed(2)}</td>
                <td className="py-2 font-semibold">{r.payableHours.toFixed(2)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-neutral-500">
                  No completed entries in range.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </main>
  );
}

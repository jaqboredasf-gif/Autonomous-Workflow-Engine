'use client';

// Payroll data-collection form: everything the payroll rules engine needs
// lives here as org settings — no code change required when policy changes.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Settings {
  org_id: string;
  timezone: string;
  rounding_minutes: number;
  ot_daily_hours: number;
  ot_weekly_hours: number;
  lunch_start: string;
  lunch_end: string;
  lunch_paid: boolean;
  lunch_auto_deduct: boolean;
  require_punch_photo: boolean;
}

const inputCls = 'rounded border px-2 py-1.5 text-sm w-full';
const labelCls = 'block text-sm text-neutral-600 dark:text-neutral-300 mt-4';

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('org_settings')
      .select('*')
      .single()
      .then(({ data, error }) => {
        if (error) setError(error.message + ' — sign in as admin on the Home page.');
        setS(data);
      });
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!s) return;
    setMsg(null);
    setError(null);
    const { error } = await supabase
      .from('org_settings')
      .update({
        timezone: s.timezone,
        rounding_minutes: s.rounding_minutes,
        ot_daily_hours: s.ot_daily_hours,
        ot_weekly_hours: s.ot_weekly_hours,
        lunch_start: s.lunch_start,
        lunch_end: s.lunch_end,
        lunch_paid: s.lunch_paid,
        lunch_auto_deduct: s.lunch_auto_deduct,
        require_punch_photo: s.require_punch_photo,
      })
      .eq('org_id', s.org_id);
    if (error) setError(error.message);
    else setMsg('Saved.');
  }

  if (error && !s) return <main className="p-8 text-red-600">{error}</main>;
  if (!s) return <main className="p-8">Loading…</main>;

  return (
    <main className="mx-auto max-w-lg p-8">
      <h1 className="text-2xl font-bold">Payroll Settings</h1>
      <p className="mt-2 text-sm text-neutral-500">
        These rules drive timesheet math and payroll exports. Change policy here, not in code.
      </p>

      <form onSubmit={save}>
        <label className={labelCls}>
          Timezone
          <input className={inputCls} value={s.timezone}
            onChange={(e) => setS({ ...s, timezone: e.target.value })} />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className={labelCls}>
            Lunch start
            <input className={inputCls} type="time" value={s.lunch_start.slice(0, 5)}
              onChange={(e) => setS({ ...s, lunch_start: e.target.value })} />
          </label>
          <label className={labelCls}>
            Lunch end
            <input className={inputCls} type="time" value={s.lunch_end.slice(0, 5)}
              onChange={(e) => setS({ ...s, lunch_end: e.target.value })} />
          </label>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.lunch_paid}
            onChange={(e) => setS({ ...s, lunch_paid: e.target.checked })} />
          Lunch is paid
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.lunch_auto_deduct}
            onChange={(e) => setS({ ...s, lunch_auto_deduct: e.target.checked })} />
          Auto-deduct lunch from shifts spanning it
        </label>

        <div className="grid grid-cols-3 gap-3">
          <label className={labelCls}>
            Rounding (min)
            <input className={inputCls} type="number" value={s.rounding_minutes}
              onChange={(e) => setS({ ...s, rounding_minutes: +e.target.value })} />
          </label>
          <label className={labelCls}>
            OT daily (h)
            <input className={inputCls} type="number" step="0.5" value={s.ot_daily_hours}
              onChange={(e) => setS({ ...s, ot_daily_hours: +e.target.value })} />
          </label>
          <label className={labelCls}>
            OT weekly (h)
            <input className={inputCls} type="number" step="0.5" value={s.ot_weekly_hours}
              onChange={(e) => setS({ ...s, ot_weekly_hours: +e.target.value })} />
          </label>
        </div>

        <label className="mt-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.require_punch_photo}
            onChange={(e) => setS({ ...s, require_punch_photo: e.target.checked })} />
          Require photo at punch
        </label>

        <button type="submit" className="mt-6 rounded bg-blue-600 px-4 py-2 text-white">
          Save settings
        </button>
        {msg && <span className="ml-3 text-sm text-green-600">{msg}</span>}
        {error && <span className="ml-3 text-sm text-red-600">{error}</span>}
      </form>
    </main>
  );
}

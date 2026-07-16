'use client';

// Scheduling core. Calendar-agnostic: the M365 Graph sync (Phase 4) will
// push these shifts to Outlook once the Entra app registration exists.

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Shift {
  id: string;
  starts_at: string;
  ends_at: string;
  status: 'planned' | 'published' | 'cancelled';
  notes: string | null;
  users: { full_name: string } | null;
  job_sites: { name: string } | null;
}

interface Option {
  id: string;
  label: string;
}

const inputCls = 'rounded border px-2 py-1.5 text-sm';

function fmtRange(a: string, b: string): string {
  const d = new Date(a);
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, opts)}–${new Date(b).toLocaleTimeString(undefined, opts)}`;
}

export default function Schedule() {
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [workers, setWorkers] = useState<Option[]>([]);
  const [sites, setSites] = useState<Option[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ userId: '', siteId: '', date: '', start: '07:00', end: '15:30' });

  async function load() {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) {
      setError('Sign in first (Home page).');
      setShifts([]);
      return;
    }
    const [{ data: me }, { data: ws }, { data: ss }, { data: sh, error: shErr }] =
      await Promise.all([
        supabase.from('users').select('org_id').eq('id', auth.user.id).single(),
        supabase.from('users').select('id, full_name').eq('is_active', true).order('full_name'),
        supabase.from('job_sites').select('id, name').eq('is_active', true).order('name'),
        supabase
          .from('shifts')
          .select('id, starts_at, ends_at, status, notes, users!shifts_user_id_fkey(full_name), job_sites(name)')
          .gte('starts_at', new Date(Date.now() - 864e5).toISOString())
          .order('starts_at')
          .overrideTypes<Shift[]>(),
      ]);
    setOrgId(me?.org_id ?? null);
    setWorkers((ws ?? []).map((w) => ({ id: w.id, label: w.full_name })));
    setSites((ss ?? []).map((s) => ({ id: s.id, label: s.name })));
    if (shErr) setError(shErr.message);
    setShifts(sh ?? []);
  }

  useEffect(() => {
    load();
  }, []);

  async function addShift(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { data: auth } = await supabase.auth.getUser();
    const { error } = await supabase.from('shifts').insert({
      org_id: orgId,
      user_id: form.userId,
      job_site_id: form.siteId || null,
      starts_at: new Date(`${form.date}T${form.start}`).toISOString(),
      ends_at: new Date(`${form.date}T${form.end}`).toISOString(),
      created_by: auth.user?.id,
    });
    if (error) {
      setError(error.message);
      return;
    }
    load();
  }

  async function cancelShift(id: string) {
    await supabase.from('shifts').update({ status: 'cancelled' }).eq('id', id);
    load();
  }

  if (!shifts) return <main className="p-8">Loading…</main>;

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-bold">Schedule</h1>

      <form onSubmit={addShift} className="mt-6 grid grid-cols-2 gap-2 rounded border p-4 md:grid-cols-6">
        <select className={inputCls} required value={form.userId}
          onChange={(e) => setForm({ ...form, userId: e.target.value })}>
          <option value="">Worker…</option>
          {workers.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
        </select>
        <select className={inputCls} value={form.siteId}
          onChange={(e) => setForm({ ...form, siteId: e.target.value })}>
          <option value="">Site…</option>
          {sites.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <input className={inputCls} required type="date" value={form.date}
          onChange={(e) => setForm({ ...form, date: e.target.value })} />
        <input className={inputCls} required type="time" value={form.start}
          onChange={(e) => setForm({ ...form, start: e.target.value })} />
        <input className={inputCls} required type="time" value={form.end}
          onChange={(e) => setForm({ ...form, end: e.target.value })} />
        <button type="submit" className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white">
          Add shift
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <table className="mt-6 w-full text-sm">
        <thead>
          <tr className="border-b text-left text-neutral-500">
            <th className="py-2 pr-4">When</th>
            <th className="py-2 pr-4">Worker</th>
            <th className="py-2 pr-4">Site</th>
            <th className="py-2 pr-4">Status</th>
            <th className="py-2"></th>
          </tr>
        </thead>
        <tbody>
          {shifts.map((s) => (
            <tr key={s.id} className={`border-b ${s.status === 'cancelled' ? 'opacity-40 line-through' : ''}`}>
              <td className="py-2 pr-4">{fmtRange(s.starts_at, s.ends_at)}</td>
              <td className="py-2 pr-4">{s.users?.full_name ?? '?'}</td>
              <td className="py-2 pr-4">{s.job_sites?.name ?? '—'}</td>
              <td className="py-2 pr-4">{s.status}</td>
              <td className="py-2">
                {s.status !== 'cancelled' && (
                  <button onClick={() => cancelShift(s.id)} className="text-xs text-red-600 underline">
                    cancel
                  </button>
                )}
              </td>
            </tr>
          ))}
          {shifts.length === 0 && (
            <tr><td colSpan={5} className="py-4 text-neutral-500">No upcoming shifts.</td></tr>
          )}
        </tbody>
      </table>
    </main>
  );
}

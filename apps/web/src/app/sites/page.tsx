'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Site {
  id: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  radius_m: number;
  is_active: boolean;
}

const inputCls = 'rounded border px-2 py-1.5 text-sm';

export default function Sites() {
  const [sites, setSites] = useState<Site[] | null>(null);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', address: '', lat: '', lng: '', radius_m: '150' });

  async function load() {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) {
      setError('Sign in first (Home page).');
      return;
    }
    const { data: me } = await supabase.from('users').select('org_id').eq('id', auth.user.id).single();
    setOrgId(me?.org_id ?? null);
    const { data, error } = await supabase.from('job_sites').select('*').order('name');
    if (error) setError(error.message);
    setSites(data ?? []);
  }

  useEffect(() => {
    load();
  }, []);

  async function addSite(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error } = await supabase.from('job_sites').insert({
      org_id: orgId,
      name: form.name,
      address: form.address || null,
      lat: parseFloat(form.lat),
      lng: parseFloat(form.lng),
      radius_m: parseInt(form.radius_m, 10),
    });
    if (error) {
      setError(error.message);
      return;
    }
    setForm({ name: '', address: '', lat: '', lng: '', radius_m: '150' });
    load();
  }

  async function toggleActive(s: Site) {
    await supabase.from('job_sites').update({ is_active: !s.is_active }).eq('id', s.id);
    load();
  }

  if (error && !sites) return <main className="p-8 text-red-600">{error}</main>;
  if (!sites) return <main className="p-8">Loading…</main>;

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-bold">Job Sites</h1>

      <form onSubmit={addSite} className="mt-6 grid grid-cols-2 gap-2 rounded border p-4 md:grid-cols-6">
        <input className={inputCls} required placeholder="Name" value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input className={inputCls} placeholder="Address" value={form.address}
          onChange={(e) => setForm({ ...form, address: e.target.value })} />
        <input className={inputCls} required type="number" step="any" placeholder="Lat" value={form.lat}
          onChange={(e) => setForm({ ...form, lat: e.target.value })} />
        <input className={inputCls} required type="number" step="any" placeholder="Lng" value={form.lng}
          onChange={(e) => setForm({ ...form, lng: e.target.value })} />
        <input className={inputCls} required type="number" placeholder="Radius m" value={form.radius_m}
          onChange={(e) => setForm({ ...form, radius_m: e.target.value })} />
        <button type="submit" className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white">
          Add site
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <table className="mt-6 w-full text-sm">
        <thead>
          <tr className="border-b text-left text-neutral-500">
            <th className="py-2 pr-4">Name</th>
            <th className="py-2 pr-4">Address</th>
            <th className="py-2 pr-4">Lat / Lng</th>
            <th className="py-2 pr-4">Radius</th>
            <th className="py-2">Active</th>
          </tr>
        </thead>
        <tbody>
          {sites.map((s) => (
            <tr key={s.id} className="border-b">
              <td className="py-2 pr-4">{s.name}</td>
              <td className="py-2 pr-4">{s.address ?? '—'}</td>
              <td className="py-2 pr-4">
                {s.lat.toFixed(5)}, {s.lng.toFixed(5)}
              </td>
              <td className="py-2 pr-4">{s.radius_m} m</td>
              <td className="py-2">
                <button
                  onClick={() => toggleActive(s)}
                  className={`rounded px-2 py-0.5 text-xs ${
                    s.is_active ? 'bg-green-100 text-green-700' : 'bg-neutral-200 text-neutral-500'
                  }`}
                >
                  {s.is_active ? 'active' : 'inactive'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

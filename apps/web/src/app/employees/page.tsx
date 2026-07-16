'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Emp {
  id: string;
  full_name: string;
  role: 'admin' | 'foreman' | 'worker';
  is_active: boolean;
  hourly_rate: number | null;
  skills: string[];
}

const inputCls = 'rounded border px-2 py-1.5 text-sm';

export default function Employees() {
  const [emps, setEmps] = useState<Emp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ full_name: '', email: '', password: '', role: 'worker' });

  async function load() {
    const { data, error } = await supabase
      .from('users')
      .select('id, full_name, role, is_active, hourly_rate, skills')
      .order('full_name');
    if (error) setError(error.message);
    setEmps(data ?? []);
  }

  async function saveSkills(id: string, raw: string) {
    const skills = raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const { error } = await supabase.from('users').update({ skills }).eq('id', id);
    if (error) setError(error.message);
    load();
  }

  useEffect(() => {
    load();
  }, []);

  async function addEmployee(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMsg(null);
    const { data: session } = await supabase.auth.getSession();
    const res = await fetch('/api/employees', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.session?.access_token ?? ''}`,
      },
      body: JSON.stringify(form),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? 'Failed');
      return;
    }
    setMsg(`Added ${form.full_name}.`);
    setForm({ full_name: '', email: '', password: '', role: 'worker' });
    load();
  }

  async function toggleActive(emp: Emp) {
    await supabase.from('users').update({ is_active: !emp.is_active }).eq('id', emp.id);
    load();
  }

  if (!emps) return <main className="p-8">Loading…</main>;

  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-bold">Employees</h1>

      <form onSubmit={addEmployee} className="mt-6 grid grid-cols-2 gap-2 rounded border p-4 md:grid-cols-5">
        <input className={inputCls} required placeholder="Full name" value={form.full_name}
          onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
        <input className={inputCls} required type="email" placeholder="Email" value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input className={inputCls} required type="password" placeholder="Temp password" value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <select className={inputCls} value={form.role}
          onChange={(e) => setForm({ ...form, role: e.target.value })}>
          <option value="worker">worker</option>
          <option value="foreman">foreman</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit" className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white">
          Add employee
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {msg && <p className="mt-2 text-sm text-green-600">{msg}</p>}

      <table className="mt-6 w-full text-sm">
        <thead>
          <tr className="border-b text-left text-neutral-500">
            <th className="py-2 pr-4">Name</th>
            <th className="py-2 pr-4">Role</th>
            <th className="py-2 pr-4">Skills (comma-separated, used by dispatch)</th>
            <th className="py-2 pr-4">Rate</th>
            <th className="py-2">Active</th>
          </tr>
        </thead>
        <tbody>
          {emps.map((e) => (
            <tr key={e.id} className="border-b">
              <td className="py-2 pr-4">{e.full_name}</td>
              <td className="py-2 pr-4">{e.role}</td>
              <td className="py-2 pr-4">
                <input
                  className="w-full rounded border px-2 py-1 text-xs"
                  defaultValue={e.skills.join(', ')}
                  placeholder="e.g. service-call, panel, rough-in"
                  onBlur={(ev) => {
                    if (ev.target.value !== e.skills.join(', ')) {
                      saveSkills(e.id, ev.target.value);
                    }
                  }}
                />
              </td>
              <td className="py-2 pr-4">{e.hourly_rate ? `$${e.hourly_rate}/h` : '—'}</td>
              <td className="py-2">
                <button
                  onClick={() => toggleActive(e)}
                  className={`rounded px-2 py-0.5 text-xs ${
                    e.is_active ? 'bg-green-100 text-green-700' : 'bg-neutral-200 text-neutral-500'
                  }`}
                >
                  {e.is_active ? 'active' : 'inactive'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

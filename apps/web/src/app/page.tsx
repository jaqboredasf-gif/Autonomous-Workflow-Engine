'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Profile {
  full_name: string;
  role: 'admin' | 'foreman' | 'worker';
}

export default function Home() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadProfile() {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) {
      setProfile(null);
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from('users')
      .select('full_name, role')
      .eq('id', auth.user.id)
      .single();
    setProfile(data);
    setLoading(false);
  }

  useEffect(() => {
    loadProfile();
  }, []);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      return;
    }
    await loadProfile();
  }

  async function signOut() {
    await supabase.auth.signOut();
    setProfile(null);
  }

  if (loading) return <main className="p-8">Loading…</main>;

  if (profile) {
    return (
      <main className="mx-auto max-w-md p-8">
        <h1 className="text-2xl font-bold">Exattime Admin</h1>
        <p className="mt-4">
          Signed in as <strong>{profile.full_name}</strong> ({profile.role})
        </p>
        <button
          onClick={signOut}
          className="mt-6 rounded bg-neutral-800 px-4 py-2 text-white"
        >
          Sign out
        </button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md p-8">
      <h1 className="text-2xl font-bold">Exattime Admin</h1>
      <form onSubmit={signIn} className="mt-6 flex flex-col gap-3">
        <input
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded border px-3 py-2"
        />
        <input
          type="password"
          required
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded border px-3 py-2"
        />
        <button type="submit" className="rounded bg-blue-600 px-4 py-2 text-white">
          Sign in
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>
    </main>
  );
}

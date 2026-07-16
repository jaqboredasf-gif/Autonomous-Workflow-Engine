'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { supabase } from '@/lib/supabase';
import type { MapPunch, MapSite } from '@/components/SiteMap';

const SiteMap = dynamic(() => import('@/components/SiteMap'), { ssr: false });

interface EntryRow {
  id: string;
  in_lat: number | null;
  in_lng: number | null;
  in_geo_flag: 'inside' | 'outside' | 'no_gps';
  clock_in: string;
  users: { full_name: string } | null;
  job_sites: { name: string } | null;
}

export default function MapPage() {
  const [sites, setSites] = useState<MapSite[] | null>(null);
  const [punches, setPunches] = useState<MapPunch[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
    Promise.all([
      supabase.from('job_sites').select('id, name, lat, lng, radius_m').eq('is_active', true),
      supabase
        .from('time_entries')
        .select(
          'id, in_lat, in_lng, in_geo_flag, clock_in, users!time_entries_user_id_fkey(full_name), job_sites(name)'
        )
        .gte('clock_in', dayAgo)
        .overrideTypes<EntryRow[]>(),
    ]).then(([s, e]) => {
      if (s.error) setError(s.error.message + ' — sign in on the Home page.');
      setSites(s.data ?? []);
      setPunches(
        (e.data ?? [])
          .filter((r) => r.in_lat != null && r.in_lng != null)
          .map((r) => ({
            id: r.id,
            lat: r.in_lat!,
            lng: r.in_lng!,
            flag: r.in_geo_flag,
            label: `${r.users?.full_name ?? '?'} — ${r.job_sites?.name ?? 'no site'} — ${new Date(
              r.clock_in
            ).toLocaleTimeString()} (${r.in_geo_flag})`,
          }))
      );
    });
  }, []);

  if (error) return <main className="p-8 text-red-600">{error}</main>;
  if (!sites) return <main className="p-8">Loading…</main>;

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-bold">Map — punches last 24h</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Blue circles = geofences. Dots: green inside, red outside, amber no GPS.
      </p>
      <div className="mt-4 overflow-hidden rounded border">
        <SiteMap sites={sites} punches={punches} />
      </div>
    </main>
  );
}

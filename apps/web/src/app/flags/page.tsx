'use client';

// Anomaly list — the human version of what the Phase 4 agent will consume
// via get_flags: outside-geofence punches, missing GPS, and forgotten
// clock-outs (open entries older than 16h).

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

interface Row {
  id: string;
  clock_in: string;
  clock_out: string | null;
  in_geo_flag: 'inside' | 'outside' | 'no_gps';
  out_geo_flag: 'inside' | 'outside' | 'no_gps' | null;
  in_photo_url: string | null;
  users: { full_name: string } | null;
  job_sites: { name: string } | null;
}

interface Flag {
  row: Row;
  kind: string;
  detail: string;
}

const OPEN_TOO_LONG_H = 16;

function buildFlags(rows: Row[]): Flag[] {
  const flags: Flag[] = [];
  for (const r of rows) {
    if (r.in_geo_flag === 'outside')
      flags.push({ row: r, kind: 'Outside fence (in)', detail: 'Clock-in outside site geofence' });
    if (r.out_geo_flag === 'outside')
      flags.push({ row: r, kind: 'Outside fence (out)', detail: 'Clock-out outside site geofence' });
    if (r.in_geo_flag === 'no_gps')
      flags.push({ row: r, kind: 'No GPS', detail: 'Clock-in without location' });
    if (!r.clock_out && Date.now() - new Date(r.clock_in).getTime() > OPEN_TOO_LONG_H * 3600_000)
      flags.push({
        row: r,
        kind: 'Missing clock-out',
        detail: `Open for ${((Date.now() - new Date(r.clock_in).getTime()) / 3600_000).toFixed(0)}h`,
      });
  }
  return flags;
}

export default function Flags() {
  const [flags, setFlags] = useState<Flag[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const from = new Date(Date.now() - 14 * 24 * 3600_000).toISOString();
    supabase
      .from('time_entries')
      .select(
        'id, clock_in, clock_out, in_geo_flag, out_geo_flag, in_photo_url, users!time_entries_user_id_fkey(full_name), job_sites(name)'
      )
      .gte('clock_in', from)
      .order('clock_in', { ascending: false })
      .overrideTypes<Row[]>()
      .then(({ data, error }) => {
        if (error) setError(error.message);
        setFlags(buildFlags(data ?? []));
      });
  }, []);

  async function openPhoto(path: string) {
    const { data } = await supabase.storage.from('punch-photos').createSignedUrl(path, 60);
    if (data?.signedUrl) window.open(data.signedUrl, '_blank');
  }

  if (error) return <main className="p-8 text-red-600">{error}</main>;
  if (!flags) return <main className="p-8">Loading…</main>;

  return (
    <main className="mx-auto max-w-4xl p-8">
      <h1 className="text-2xl font-bold">Flags — last 14 days</h1>
      {flags.length === 0 ? (
        <p className="mt-6 text-neutral-500">No anomalies. Clean punches all around.</p>
      ) : (
        <table className="mt-6 w-full text-sm">
          <thead>
            <tr className="border-b text-left text-neutral-500">
              <th className="py-2 pr-4">Flag</th>
              <th className="py-2 pr-4">Employee</th>
              <th className="py-2 pr-4">Site</th>
              <th className="py-2 pr-4">When</th>
              <th className="py-2 pr-4">Detail</th>
              <th className="py-2">Photo</th>
            </tr>
          </thead>
          <tbody>
            {flags.map((f, i) => (
              <tr key={`${f.row.id}-${i}`} className="border-b">
                <td className="py-2 pr-4 font-semibold text-red-600">{f.kind}</td>
                <td className="py-2 pr-4">{f.row.users?.full_name ?? '?'}</td>
                <td className="py-2 pr-4">{f.row.job_sites?.name ?? '—'}</td>
                <td className="py-2 pr-4">{new Date(f.row.clock_in).toLocaleString()}</td>
                <td className="py-2 pr-4">{f.detail}</td>
                <td className="py-2">
                  {f.row.in_photo_url ? (
                    <button
                      className="text-blue-600 underline"
                      onClick={() => openPhoto(f.row.in_photo_url!)}
                    >
                      view
                    </button>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

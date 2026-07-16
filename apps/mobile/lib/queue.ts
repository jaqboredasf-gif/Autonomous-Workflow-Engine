// Offline punch queue. Punches that fail to reach the server (no signal on
// site) are stored locally and flushed in order on the next opportunity.
// Server-side idempotency: unique (device_id, client_uuid) on time_entries.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

const QUEUE_KEY = 'exattime.punch-queue';
const DEVICE_KEY = 'exattime.device-id';

export interface QueuedPunch {
  kind: 'in' | 'out';
  clientUuid: string;
  at: string; // device-time ISO timestamp
  userId: string;
  orgId: string;
  jobSiteId: string | null;
  costCodeId: string | null;
  lat: number | null;
  lng: number | null;
}

export function genId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = genId();
    await AsyncStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

async function readQueue(): Promise<QueuedPunch[]> {
  const raw = await AsyncStorage.getItem(QUEUE_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function writeQueue(q: QueuedPunch[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(q));
}

export async function enqueue(p: QueuedPunch): Promise<number> {
  const q = await readQueue();
  q.push(p);
  await writeQueue(q);
  return q.length;
}

export async function queueLength(): Promise<number> {
  return (await readQueue()).length;
}

/** Send a punch to the server. Throws on network/server failure. */
export async function sendPunch(p: QueuedPunch, deviceId: string): Promise<void> {
  if (p.kind === 'in') {
    const { error } = await supabase.from('time_entries').insert({
      org_id: p.orgId,
      user_id: p.userId,
      job_site_id: p.jobSiteId,
      cost_code_id: p.costCodeId,
      clock_in: p.at,
      in_lat: p.lat,
      in_lng: p.lng,
      device_id: deviceId,
      client_uuid: p.clientUuid,
    });
    // 23505 = duplicate (device_id, client_uuid): already synced, not an error.
    if (error && error.code !== '23505') throw error;
  } else {
    const { data: open, error: findErr } = await supabase
      .from('time_entries')
      .select('id')
      .eq('user_id', p.userId)
      .is('clock_out', null)
      .order('clock_in', { ascending: false })
      .limit(1);
    if (findErr) throw findErr;
    if (!open?.length) return; // nothing open — punch-out already applied
    const { error } = await supabase
      .from('time_entries')
      .update({ clock_out: p.at, out_lat: p.lat, out_lng: p.lng })
      .eq('id', open[0].id);
    if (error) throw error;
  }
}

/** Flush queued punches in order. Stops at first failure (stay ordered). */
export async function flushQueue(): Promise<{ sent: number; remaining: number }> {
  const q = await readQueue();
  const deviceId = await getDeviceId();
  let sent = 0;
  while (q.length > 0) {
    try {
      await sendPunch(q[0], deviceId);
      q.shift();
      sent++;
      await writeQueue(q);
    } catch {
      break;
    }
  }
  return { sent, remaining: q.length };
}

import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Location from 'expo-location';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { enqueue, flushQueue, genId, getDeviceId, queueLength, sendPunch } from './lib/queue';

interface Profile {
  org_id: string;
  full_name: string;
}
interface Site {
  id: string;
  name: string;
  lat: number;
  lng: number;
}
interface CostCode {
  id: string;
  code: string;
  label: string;
}

function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(bLat - aLat) / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {session ? <PunchScreen userId={session.user.id} /> : <LoginScreen />}
    </View>
  );
}

function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
  }

  return (
    <View style={styles.center}>
      <Text style={styles.title}>Exattime</Text>
      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor="#888"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor="#888"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      <Pressable style={styles.primaryBtn} onPress={signIn}>
        <Text style={styles.primaryBtnText}>Sign in</Text>
      </Pressable>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

function PunchScreen({ userId }: { userId: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [codes, setCodes] = useState<CostCode[]>([]);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [codeId, setCodeId] = useState<string | null>(null);
  const [clockedIn, setClockedIn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(0);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: prof }, { data: siteRows }, { data: codeRows }, { data: open }] =
      await Promise.all([
        supabase.from('users').select('org_id, full_name').eq('id', userId).single(),
        supabase.from('job_sites').select('id, name, lat, lng').eq('is_active', true),
        supabase.from('cost_codes').select('id, code, label').eq('is_active', true),
        supabase.from('time_entries').select('id').eq('user_id', userId).is('clock_out', null),
      ]);
    setProfile(prof);
    setCodes(codeRows ?? []);
    setClockedIn((open ?? []).length > 0);

    let ordered = siteRows ?? [];
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        ordered = [...ordered].sort(
          (a, b) =>
            distanceKm(pos.coords.latitude, pos.coords.longitude, a.lat, a.lng) -
            distanceKm(pos.coords.latitude, pos.coords.longitude, b.lat, b.lng)
        );
      }
    } catch {
      // no GPS — keep unsorted
    }
    setSites(ordered);
    if (ordered.length > 0) setSiteId((prev) => prev ?? ordered[0].id);
    setQueued(await queueLength());
    const flushed = await flushQueue();
    if (flushed.sent > 0) setQueued(flushed.remaining);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  async function punch(kind: 'in' | 'out') {
    if (!profile || busy) return;
    setBusy(true);
    setStatus(null);
    let lat: number | null = null;
    let lng: number | null = null;
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        lat = pos.coords.latitude;
        lng = pos.coords.longitude;
      }
    } catch {
      // punch proceeds without GPS; server flags it no_gps
    }

    const p = {
      kind,
      clientUuid: genId(),
      at: new Date().toISOString(),
      userId,
      orgId: profile.org_id,
      jobSiteId: siteId,
      costCodeId: kind === 'in' ? codeId : null,
      lat,
      lng,
    };
    try {
      await sendPunch(p, await getDeviceId());
      setStatus(kind === 'in' ? 'Clocked in ✓' : 'Clocked out ✓');
    } catch {
      const n = await enqueue(p);
      setQueued(n);
      setStatus('No signal — punch queued, will sync');
    }
    setClockedIn(kind === 'in');
    setBusy(false);
  }

  if (!profile || clockedIn === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Hi, {profile.full_name.split(' ')[0]}</Text>
      {queued > 0 && <Text style={styles.badge}>{queued} punch(es) waiting to sync</Text>}

      <Text style={styles.label}>Job site</Text>
      <FlatList
        style={styles.picker}
        data={sites}
        keyExtractor={(s) => s.id}
        renderItem={({ item }) => (
          <Pressable
            style={[styles.row, item.id === siteId && styles.rowActive]}
            onPress={() => setSiteId(item.id)}
          >
            <Text style={styles.rowText}>{item.name}</Text>
          </Pressable>
        )}
      />

      {!clockedIn && (
        <>
          <Text style={styles.label}>Cost code</Text>
          <FlatList
            style={styles.picker}
            data={codes}
            keyExtractor={(c) => c.id}
            renderItem={({ item }) => (
              <Pressable
                style={[styles.row, item.id === codeId && styles.rowActive]}
                onPress={() => setCodeId(item.id)}
              >
                <Text style={styles.rowText}>
                  {item.code} — {item.label}
                </Text>
              </Pressable>
            )}
          />
        </>
      )}

      <Pressable
        style={[styles.punchBtn, clockedIn ? styles.punchOut : styles.punchIn]}
        disabled={busy}
        onPress={() => punch(clockedIn ? 'out' : 'in')}
      >
        <Text style={styles.punchText}>
          {busy ? '…' : clockedIn ? 'CLOCK OUT' : 'CLOCK IN'}
        </Text>
      </Pressable>
      {status && <Text style={styles.status}>{status}</Text>}

      <Pressable onPress={() => supabase.auth.signOut()}>
        <Text style={styles.signOut}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  screen: { flex: 1, padding: 24, paddingTop: 72 },
  title: { color: '#fff', fontSize: 28, fontWeight: '700', marginBottom: 12 },
  input: {
    width: '100%',
    backgroundColor: '#222',
    color: '#fff',
    borderRadius: 8,
    padding: 12,
    marginTop: 10,
  },
  primaryBtn: {
    marginTop: 16,
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 32,
  },
  primaryBtnText: { color: '#fff', fontWeight: '600' },
  error: { color: '#f87171', marginTop: 12 },
  label: { color: '#aaa', marginTop: 16, marginBottom: 6, fontSize: 13 },
  picker: { maxHeight: 130, flexGrow: 0 },
  row: { padding: 12, borderRadius: 8, backgroundColor: '#1c1c1c', marginBottom: 6 },
  rowActive: { backgroundColor: '#1e3a8a' },
  rowText: { color: '#eee' },
  punchBtn: {
    marginTop: 24,
    borderRadius: 16,
    paddingVertical: 28,
    alignItems: 'center',
  },
  punchIn: { backgroundColor: '#16a34a' },
  punchOut: { backgroundColor: '#dc2626' },
  punchText: { color: '#fff', fontSize: 24, fontWeight: '800', letterSpacing: 2 },
  status: { color: '#a3e635', marginTop: 12, textAlign: 'center' },
  badge: { color: '#fbbf24', marginBottom: 4 },
  signOut: { color: '#666', textAlign: 'center', marginTop: 20 },
});

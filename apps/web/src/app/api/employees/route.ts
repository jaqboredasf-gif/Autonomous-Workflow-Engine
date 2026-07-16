// Employee creation needs the service-role key (auth admin API), so it runs
// server-side. Caller must present a valid session token for an admin user.

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function POST(req: Request) {
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const token = req.headers.get('authorization')?.replace(/^Bearer /i, '');
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { data: caller, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !caller.user) {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 });
  }

  const { data: me } = await admin
    .from('users')
    .select('org_id, role')
    .eq('id', caller.user.id)
    .single();
  if (me?.role !== 'admin') {
    return NextResponse.json({ error: 'Admins only' }, { status: 403 });
  }

  const body = await req.json();
  const { email, password, full_name, role } = body ?? {};
  if (!email || !password || !full_name || !['admin', 'foreman', 'worker'].includes(role)) {
    return NextResponse.json(
      { error: 'email, password, full_name, role required' },
      { status: 400 }
    );
  }

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr) return NextResponse.json({ error: createErr.message }, { status: 400 });

  const { error: insertErr } = await admin.from('users').insert({
    id: created.user.id,
    org_id: me.org_id,
    role,
    full_name,
  });
  if (insertErr) {
    await admin.auth.admin.deleteUser(created.user.id);
    return NextResponse.json({ error: insertErr.message }, { status: 400 });
  }

  return NextResponse.json({ id: created.user.id });
}

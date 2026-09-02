'use client';

// ---------------------------------------------------------------------------
// /requests/new — "New Work Request" (TEMPORARY manual intake bridge)
//
// The shell around src/lib/manual-intake.ts. It calls NOTHING that
// planManualIntake() did not return, so an invalid or unauthorized entry never
// leaves the browser.
//
// Email-first remains the MVP intake architecture. This exists because Graph
// inbound is blocked on Entra and, until it lands, no real work can enter AWE
// at all. It writes `source = 'manual'` and can never produce a row that looks
// like email — 0016's constraint enforces that in the database, not here.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { planManualIntake, verifyIntakeApplied } from '@/lib/manual-intake';

const field =
  'mt-1 w-full rounded border px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900';
const label = 'block text-sm font-medium text-neutral-800 dark:text-neutral-200';

function localNowValue(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export default function NewRequestPage() {
  const [signedIn, setSignedIn] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // One key per form session. A double-clicked submit returns the SAME request
  // instead of creating a second one (0016 idempotency).
  const [clientKey, setClientKey] = useState<string>('');

  const [bodyText, setBodyText] = useState('');
  const [sourceReference, setSourceReference] = useState('');
  const [receivedAt, setReceivedAt] = useState(localNowValue());
  const [subject, setSubject] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [county, setCounty] = useState('');
  const [zip, setZip] = useState('');

  useEffect(() => {
    setClientKey(crypto.randomUUID());
    let alive = true;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!alive) return;
      if (!user) { setSignedIn(false); setChecking(false); return; }
      const { data: ok } = await supabase.rpc('current_role_is', { role: 'admin' });
      if (!alive) return;
      setIsAdmin(ok === true);
      setChecking(false);
    })();
    return () => { alive = false; };
  }, []);

  async function submit() {
    setNotice(null);
    setErrors({});

    const plan = planManualIntake({
      input: {
        bodyText, sourceReference, receivedAt: new Date(receivedAt).toISOString(),
        subject, customerName, customerEmail, customerPhone,
        customerAddress, county, zip, clientKey,
      },
      now: new Date().toISOString(),
      isAuthorized: isAdmin,
    });

    if (!plan.ok) {
      const map: Record<string, string> = {};
      for (const e of plan.errors) map[e.field] = e.detail;
      setErrors(map);
      setNotice({ kind: 'error', text: 'Nothing was submitted — fix the highlighted fields.' });
      return;
    }

    setBusy(true);
    const { data: id, error } = await supabase.rpc('create_manual_work_request', plan.rpc!);

    if (error) {
      // The database is the authority; show exactly what it refused with.
      setNotice({ kind: 'error', text: error.message });
      setBusy(false);
      return;
    }

    // Deterministic refresh: success is what the re-read says.
    const { data: row } = await supabase
      .from('work_requests')
      .select('id')
      .eq('id', id as string)
      .maybeSingle();

    const verdict = verifyIntakeApplied({
      workRequestId: (id as string) ?? null,
      found: Boolean(row),
    });
    setNotice({ kind: verdict.settled ? 'success' : 'error', text: verdict.message });

    if (verdict.settled) {
      setBodyText(''); setSourceReference(''); setSubject('');
      setCustomerName(''); setCustomerEmail(''); setCustomerPhone('');
      setCustomerAddress(''); setCounty(''); setZip('');
      setReceivedAt(localNowValue());
      setClientKey(crypto.randomUUID());
    }
    setBusy(false);
  }

  if (checking) return <main className="mx-auto max-w-3xl p-8 text-sm">Loading…</main>;
  if (!signedIn) return <main className="mx-auto max-w-3xl p-8 text-sm">Sign in to enter a work request.</main>;

  return (
    <main className="mx-auto w-full max-w-3xl p-4 sm:p-8">
      <h1 className="text-xl font-semibold">New work request</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        For requests that arrive by phone, text or in person. Email requests are
        intended to arrive on their own — this form is a temporary bridge while
        mailbox intake is unavailable, not the normal way in.
      </p>

      {!isAdmin && (
        <p className="mt-4 rounded bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
          Your account cannot create work requests.
        </p>
      )}

      {notice && (
        <p className={`mt-4 rounded px-3 py-2 text-sm ${
          notice.kind === 'success'
            ? 'bg-green-100 text-green-900 dark:bg-green-900/40 dark:text-green-100'
            : 'bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100'}`}>
          {notice.text}
        </p>
      )}

      <div className="mt-6 space-y-4">
        <div>
          <label className={label} htmlFor="bodyText">What did they ask for? *</label>
          <textarea id="bodyText" rows={5} value={bodyText} className={field}
            onChange={(e) => setBodyText(e.target.value)}
            placeholder="Write what the customer actually said, in their words where you can." />
          {errors.bodyText && <p className="mt-1 text-sm text-red-700 dark:text-red-400">{errors.bodyText}</p>}
        </div>

        <div>
          <label className={label} htmlFor="sourceReference">Where did it come from? *</label>
          <input id="sourceReference" value={sourceReference} className={field}
            onChange={(e) => setSourceReference(e.target.value)}
            placeholder='e.g. "Phone call from 914-555-0134" or "Walk-in"' />
          <p className="mt-1 text-xs text-neutral-500">
            Recorded as the real-world origin. This is never used as a reply address.
          </p>
          {errors.sourceReference && <p className="mt-1 text-sm text-red-700 dark:text-red-400">{errors.sourceReference}</p>}
        </div>

        <div>
          <label className={label} htmlFor="receivedAt">When did it come in? *</label>
          <input id="receivedAt" type="datetime-local" value={receivedAt} className={field}
            onChange={(e) => setReceivedAt(e.target.value)} />
          {errors.receivedAt && <p className="mt-1 text-sm text-red-700 dark:text-red-400">{errors.receivedAt}</p>}
        </div>

        <details className="rounded border p-3 dark:border-neutral-700">
          <summary className="cursor-pointer text-sm font-medium">
            Customer details (optional — leave blank rather than guessing)
          </summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <label className={label} htmlFor="customerName">Name</label>
              <input id="customerName" value={customerName} className={field}
                onChange={(e) => setCustomerName(e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor="customerPhone">Phone</label>
              <input id="customerPhone" value={customerPhone} className={field}
                onChange={(e) => setCustomerPhone(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <label className={label} htmlFor="customerEmail">Email</label>
              <input id="customerEmail" value={customerEmail} className={field}
                onChange={(e) => setCustomerEmail(e.target.value)} />
              <p className="mt-1 text-xs text-neutral-500">
                Used as the reply address if we write back. Leave blank if unsure.
              </p>
              {errors.customerEmail && <p className="mt-1 text-sm text-red-700 dark:text-red-400">{errors.customerEmail}</p>}
            </div>
            <div className="sm:col-span-2">
              <label className={label} htmlFor="customerAddress">Address</label>
              <input id="customerAddress" value={customerAddress} className={field}
                onChange={(e) => setCustomerAddress(e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor="county">County</label>
              <input id="county" value={county} className={field}
                onChange={(e) => setCounty(e.target.value)} />
            </div>
            <div>
              <label className={label} htmlFor="zip">ZIP</label>
              <input id="zip" value={zip} className={field}
                onChange={(e) => setZip(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <label className={label} htmlFor="subject">Short summary</label>
              <input id="subject" value={subject} className={field}
                onChange={(e) => setSubject(e.target.value)} />
            </div>
          </div>
        </details>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <button onClick={() => void submit()} disabled={busy || !isAdmin}
            className="rounded bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900">
            {busy ? 'Creating…' : 'Create work request'}
          </button>
          <span className="text-xs text-neutral-500">
            Nothing is sent to the customer. This only records the request.
          </span>
        </div>
      </div>
    </main>
  );
}

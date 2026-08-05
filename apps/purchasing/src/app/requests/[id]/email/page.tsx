'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { inputClass } from '@/components/Field';
import { buildEmailDraft, buildMailtoHref, draftToClipboardText } from '@/lib/email-draft';
import { formatDate, formatMoney } from '@/lib/format';
import { usePurchasing } from '@/lib/store-context';

export default function EmailDraftPreview() {
  const params = useParams<{ id: string }>();
  const { requestById, jobById, vendorById, requestorById, hydrated } = usePurchasing();
  const [copied, setCopied] = useState(false);

  const request = requestById(params.id);
  const job = request ? jobById(request.jobId) : undefined;
  const vendor = request ? vendorById(request.vendorId) : undefined;
  const requestor = request ? requestorById(request.requestorId) : undefined;

  const generated = request
    ? buildEmailDraft(request, vendor, job, requestor?.name ?? 'Lippolis Electric')
    : null;

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');

  // Re-seed the editable fields whenever the underlying draft changes (first
  // load, hydration from localStorage, a newly generated PO number).
  useEffect(() => {
    if (generated) setSubject(generated.subject);
  }, [generated?.subject]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (generated) setBody(generated.body);
  }, [generated?.body]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!request || !generated) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16 text-center">
        <h1 className="text-xl font-bold text-neutral-900">
          {hydrated ? 'Request not found' : 'Loading…'}
        </h1>
      </main>
    );
  }

  const edited = { ...generated, subject, body };

  async function copy() {
    try {
      await navigator.clipboard.writeText(draftToClipboardText(edited));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <Link
        href={`/requests/${request.id}`}
        className="text-sm font-medium text-neutral-600 hover:text-neutral-900"
      >
        ← Return to request
      </Link>

      <h1 className="mt-3 text-2xl font-bold tracking-tight text-neutral-900">Email Draft</h1>
      <p className="mt-1 text-sm text-neutral-600">
        Nothing is sent from this screen. Copy the text, or open it in your own mail client and
        review it before you press send there.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section className="rounded-lg border border-neutral-200 bg-white p-4 lg:col-span-2">
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-neutral-600">
                To (supplier recipient placeholder)
              </label>
              <input
                readOnly
                value={generated.to}
                className={`mt-1.5 ${inputClass} bg-neutral-50 font-mono text-xs text-neutral-600`}
              />
              <p className="mt-1 text-xs text-neutral-500">
                Demo address on a reserved <code>.test</code> domain — it cannot receive mail.
              </p>
            </div>

            <div>
              <label
                htmlFor="subject"
                className="block text-xs font-semibold uppercase tracking-wide text-neutral-600"
              >
                Subject
              </label>
              <input
                id="subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className={`mt-1.5 ${inputClass}`}
              />
            </div>

            <div>
              <label
                htmlFor="body"
                className="block text-xs font-semibold uppercase tracking-wide text-neutral-600"
              >
                Body (editable)
              </label>
              <textarea
                id="body"
                rows={22}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className={`mt-1.5 ${inputClass} font-mono text-xs leading-relaxed`}
              />
            </div>

            <div className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 px-3 py-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Attachment
              </p>
              <p className="mt-1 text-sm text-neutral-700">📎 {generated.attachmentLabel}</p>
              <p className="text-xs text-neutral-500">
                Placeholder — file attachment is not implemented in the demo.
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={copy}
              className="rounded-md bg-blue-700 px-3.5 py-2 text-sm font-semibold text-white hover:bg-blue-800"
            >
              {copied ? 'Copied ✓' : 'Copy email'}
            </button>
            <a
              href={buildMailtoHref(edited)}
              className="rounded-md border border-neutral-300 bg-white px-3.5 py-2 text-sm font-semibold text-neutral-800 hover:bg-neutral-50"
            >
              Open in email client
            </a>
            <Link
              href={`/requests/${request.id}`}
              className="rounded-md border border-neutral-300 bg-white px-3.5 py-2 text-sm font-semibold text-neutral-800 hover:bg-neutral-50"
            >
              Return to request
            </Link>
          </div>
        </section>

        <aside className="space-y-4">
          <section className="rounded-lg border border-neutral-200 bg-white p-4">
            <h2 className="text-sm font-semibold text-neutral-900">PO summary</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <Row label="PO number" value={request.poNumber ?? 'Not generated yet'} mono />
              <Row label="Request" value={request.id} />
              <Row label="Vendor" value={vendor?.name ?? '—'} />
              <Row label="Job" value={job ? `${job.number} — ${job.name}` : '—'} />
              <Row label="Needed by" value={formatDate(request.neededBy)} />
              <Row label="Line items" value={String(request.lines.length)} />
              <Row label="Estimated cost" value={formatMoney(request.estimatedCost)} />
            </dl>
            {!request.poNumber && (
              <p className="mt-3 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
                Generate a PO first so the supplier has a number to reference.
              </p>
            )}
          </section>

          <section className="rounded-lg border border-amber-300 bg-amber-50 p-4">
            <h2 className="text-sm font-semibold text-amber-900">What this button does</h2>
            <p className="mt-1 text-xs text-amber-900">
              <strong>Open in email client</strong> hands the draft to whatever mail app is
              registered on this machine. The prototype has no mail server, no API key, and no
              send capability of its own.
            </p>
          </section>
        </aside>
      </div>
    </main>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-neutral-500">{label}</dt>
      <dd className={`text-right font-medium text-neutral-900 ${mono ? 'font-mono text-xs' : ''}`}>
        {value}
      </dd>
    </div>
  );
}

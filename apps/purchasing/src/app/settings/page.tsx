'use client';

import { useState } from 'react';
import { inputClass } from '@/components/Field';
import { formatPoNumber, PO_PREFIX } from '@/lib/po';
import { usePurchasing } from '@/lib/store-context';
import type { ApprovalMode } from '@/lib/types';

const MODES: { value: ApprovalMode; label: string; help: string }[] = [
  {
    value: 'never',
    label: 'No approval required',
    help: 'Submitted requests go straight to Approved. Fastest for the field, least control.',
  },
  {
    value: 'threshold',
    label: 'Approval required above a dollar amount',
    help: 'Small buys move on their own; larger ones wait for a sign-off.',
  },
  {
    value: 'always',
    label: 'Approval required for every request',
    help: 'Nothing is ordered without someone approving it first.',
  },
];

export default function Settings() {
  const { state, updateSettings, resetDemoData } = usePurchasing();
  const { settings } = state;
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Settings</h1>
      <p className="mt-1 text-sm text-neutral-600">
        Approval behavior is configurable on purpose — this is one of the rules we need
        management to decide.
      </p>

      <section className="mt-6 rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-neutral-900">Approval rules</h2>

        <div className="mt-3 space-y-3">
          {MODES.map((m) => (
            <label key={m.value} className="flex cursor-pointer gap-3">
              <input
                type="radio"
                name="approvalMode"
                className="mt-1"
                checked={settings.approvalMode === m.value}
                onChange={() => updateSettings({ ...settings, approvalMode: m.value })}
              />
              <span>
                <span className="block text-sm font-medium text-neutral-900">{m.label}</span>
                <span className="block text-xs text-neutral-500">{m.help}</span>
              </span>
            </label>
          ))}
        </div>

        {settings.approvalMode === 'threshold' && (
          <div className="mt-4 max-w-xs">
            <label
              htmlFor="threshold"
              className="block text-xs font-semibold uppercase tracking-wide text-neutral-600"
            >
              Approval threshold (USD)
            </label>
            <input
              id="threshold"
              type="number"
              min={0}
              step="50"
              value={settings.approvalThreshold}
              onChange={(e) =>
                updateSettings({
                  ...settings,
                  approvalThreshold: Math.max(0, Number(e.target.value) || 0),
                })
              }
              className={`mt-1.5 ${inputClass}`}
            />
            <p className="mt-1 text-xs text-neutral-500">
              Requests at or above this estimated cost require approval.
            </p>
          </div>
        )}

        <label className="mt-4 flex cursor-pointer items-start gap-3 border-t border-neutral-100 pt-4">
          <input
            type="checkbox"
            className="mt-1"
            checked={settings.alwaysApproveEmergency}
            onChange={(e) =>
              updateSettings({ ...settings, alwaysApproveEmergency: e.target.checked })
            }
          />
          <span>
            <span className="block text-sm font-medium text-neutral-900">
              Emergency priority always requires approval
            </span>
            <span className="block text-xs text-neutral-500">
              Applies even when the rules above would let the request through.
            </span>
          </span>
        </label>
      </section>

      <section className="mt-6 rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-neutral-900">Purchase order numbering</h2>
        <p className="mt-2 text-sm text-neutral-700">
          Next number to be issued:{' '}
          <span className="rounded bg-neutral-900 px-2 py-0.5 font-mono text-xs font-semibold text-white">
            {formatPoNumber(settings.nextPoNumber)}
          </span>
        </p>
        <p className="mt-2 text-xs text-neutral-500">
          Numbers increase by one each time a PO is generated. Every number in this prototype
          carries the <code>{PO_PREFIX}</code> prefix and there is deliberately no way to change
          it here — issuing numbers from the real PO book requires the owner&rsquo;s explicit
          authorization and a decision about which system owns the sequence.
        </p>
      </section>

      <section className="mt-6 rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-neutral-900">Demo data</h2>
        <p className="mt-2 text-xs text-neutral-500">
          All demo data lives in this browser only. Resetting restores the sample vendors, jobs,
          requestors, and requests, and sets the next PO number back to{' '}
          <span className="font-mono">{formatPoNumber(52901)}</span>.
        </p>
        {confirmReset ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                resetDemoData();
                setConfirmReset(false);
              }}
              className="rounded-md border border-red-300 bg-white px-3.5 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"
            >
              Yes, discard my changes and reset
            </button>
            <button
              type="button"
              onClick={() => setConfirmReset(false)}
              className="rounded-md border border-neutral-300 px-3.5 py-2 text-sm font-semibold text-neutral-800 hover:bg-neutral-50"
            >
              Never mind
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            className="mt-3 rounded-md border border-neutral-300 px-3.5 py-2 text-sm font-semibold text-neutral-800 hover:bg-neutral-50"
          >
            Reset demo data
          </button>
        )}
      </section>
    </main>
  );
}

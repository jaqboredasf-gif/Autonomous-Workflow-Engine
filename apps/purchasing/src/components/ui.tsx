// Shared presentational pieces. Server components — no state, no effects.
import Link from 'next/link';

import { statusLabel, statusTone } from '../purchasing/domain/status.mjs';
import { formatMoney, formatQty } from '../purchasing/domain/numbers.mjs';

const TONE: Record<string, string> = {
  good: 'bg-emerald-100 text-emerald-900 ring-emerald-300',
  bad: 'bg-rose-100 text-rose-900 ring-rose-300',
  warn: 'bg-amber-100 text-amber-900 ring-amber-300',
  attention: 'bg-sky-100 text-sky-900 ring-sky-300',
  neutral: 'bg-slate-100 text-slate-800 ring-slate-300',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${
        TONE[statusTone(status)] ?? TONE.neutral
      }`}
    >
      {statusLabel(status)}
    </span>
  );
}

export function Money({ cents }: { cents: number | null | undefined }) {
  return <span className="tabular-nums">{formatMoney(cents ?? 0)}</span>;
}

export function Qty({ value, unit }: { value: number | null | undefined; unit?: string }) {
  return (
    <span className="tabular-nums">
      {formatQty(value ?? 0)}
      {unit ? ` ${unit}` : ''}
    </span>
  );
}

export function Card({
  title,
  value,
  hint,
  href,
  tone = 'neutral',
}: {
  title: string;
  value: string | number;
  hint?: string;
  href?: string;
  tone?: 'neutral' | 'attention' | 'warn' | 'bad' | 'good';
}) {
  const body = (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-slate-300">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{title}</div>
      <div
        className={`mt-1 text-2xl font-semibold tabular-nums ${
          tone === 'bad' ? 'text-rose-700' : tone === 'warn' ? 'text-amber-700' : tone === 'attention' ? 'text-sky-700' : 'text-slate-900'
        }`}
      >
        {value}
      </div>
      {hint ? <div className="mt-1 text-xs text-slate-500">{hint}</div> : null}
    </div>
  );
  return href ? <Link href={href}>{body}</Link> : body;
}

export function Section({
  title,
  subtitle,
  children,
  actions,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
          {subtitle ? <p className="text-xs text-slate-500">{subtitle}</p> : null}
        </div>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Field({
  label,
  children,
  hint,
  required,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-700">
        {label}
        {required ? <span className="text-rose-600"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 shadow-sm ' +
  'focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500';

export const buttonClass =
  'inline-flex items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white ' +
  'shadow-sm transition hover:bg-slate-700 disabled:opacity-50';

export const secondaryButtonClass =
  'inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm ' +
  'font-medium text-slate-800 shadow-sm transition hover:bg-slate-50';

export function ReadOnly({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm text-slate-900">{value || <span className="text-slate-400">—</span>}</div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-slate-500">{children}</p>;
}

/**
 * The pilot's honesty bar. It states the two things a user must know before
 * trusting what they see: nothing is emailed automatically, and sign-in is
 * identification rather than authentication.
 */
export function PilotBanner() {
  return (
    <div className="no-print bg-amber-100 px-4 py-2 text-center text-xs text-amber-950">
      <strong>PILOT</strong> — email is draft-only: no message is sent to a supplier by this system. A
      human reviews every draft and sends it from their own mail client.
    </div>
  );
}

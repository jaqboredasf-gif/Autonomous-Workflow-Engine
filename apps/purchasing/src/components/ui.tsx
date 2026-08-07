// Shared presentational pieces. Server components — no state, no effects.
//
// This module predates the PCC component library in ./pcc and is still what
// the older screens import. It is now a THIN ADAPTER over that library rather
// than a second implementation: StatusBadge, Card and Section delegate, and
// the class-string exports resolve to the same design tokens. Screens can be
// moved across one at a time without a flag day, and neither vocabulary can
// drift from the other because there is only one underneath.
import Link from 'next/link';

import { StatusBadge as PccStatusBadge } from './pcc/Badge';
import { Panel } from './pcc/Card';
import { buttonStyle } from './pcc/Button';
import { fieldStyle } from './pcc/Input';
import { EmptyState } from './pcc/Feedback';
import type { Tone } from './pcc/status-display';

export { PccStatusBadge as StatusBadge };
export { Money, Qty } from './pcc/Value';

const CARD_TONES: Record<string, string> = {
  bad: 'text-danger',
  warn: 'text-warning',
  attention: 'text-action',
  good: 'text-success',
  neutral: 'text-ink',
};

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
  tone?: Tone;
}) {
  const body = (
    <div className="h-full rounded-lg border border-line bg-surface p-4 shadow-card transition hover:border-line-strong">
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${CARD_TONES[tone] ?? CARD_TONES.neutral}`}>{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
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
    <Panel title={title} subtitle={subtitle} actions={actions}>
      {children}
    </Panel>
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
      <span className="mb-1 block text-xs font-semibold text-ink-soft">
        {label}
        {required ? <span className="text-danger"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export const inputClass = fieldStyle();

export const buttonClass = buttonStyle('primary', 'm');

export const secondaryButtonClass = buttonStyle('secondary', 'm');

export function ReadOnly({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</div>
      <div className="text-sm text-ink">{value || <span className="text-muted">—</span>}</div>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <EmptyState title={typeof children === 'string' ? children : 'Nothing here yet'} description={typeof children === 'string' ? undefined : children} />;
}

/**
 * The pilot's honesty bar. It states the thing a user must know before
 * trusting what they see: nothing is emailed automatically.
 */
export function PilotBanner() {
  return (
    <div className="no-print border-b border-warning/30 bg-warning-bg px-4 py-2 text-center text-xs text-ink-soft">
      <strong className="font-semibold text-warning">PILOT</strong> — email is draft-only: no message is sent to a
      supplier by this system. A human reviews every draft and sends it from their own mail client.
    </div>
  );
}

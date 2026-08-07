// Badges. Status is ALWAYS text — the colour is a second signal, never the
// only one (01_IMPLEMENTATION_CONTRACT invariant 2, and the reason none of
// these render an unlabelled dot).
import { displayStatus, toneFor, urgencyOf, urgencyTone, URGENCY_LABELS, type Tone, type Urgency } from './status-display';

const TONES: Record<Tone, string> = {
  neutral: 'bg-subtle text-ink-soft ring-line-strong',
  info: 'bg-info-bg text-info ring-info/30',
  attention: 'bg-action-soft text-action ring-action/30',
  warn: 'bg-warning-bg text-warning ring-warning/30',
  good: 'bg-success-bg text-success ring-success/30',
  bad: 'bg-danger-bg text-danger ring-danger/30',
};

export function Badge({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status, className = '' }: { status: string; className?: string }) {
  return (
    <Badge tone={toneFor(status)} className={className}>
      {displayStatus(status)}
    </Badge>
  );
}

/**
 * The handoff's "Priority", derived from the need-by moment rather than stored.
 * See status-display.ts for why. Normal renders as plain text so the two that
 * matter stand out on a dense board.
 */
export function UrgencyBadge({
  request,
  now,
  className = '',
}: {
  request: { needByDate?: string | null; needByTime?: string | null; status?: string };
  now: string;
  className?: string;
}) {
  const urgency: Urgency = urgencyOf(request, now);
  if (urgency === 'NONE') return <span className="text-xs text-muted">—</span>;
  if (urgency === 'NORMAL') return <span className={`text-xs text-muted ${className}`}>Normal</span>;
  return (
    <Badge tone={urgencyTone(urgency)} className={className}>
      {URGENCY_LABELS[urgency]}
    </Badge>
  );
}

/** A count pill for tabs and sidebar destinations. */
export function CountPill({ count, selected = false }: { count: number; selected?: boolean }) {
  return (
    <span
      className={`ml-auto inline-flex min-w-6 justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums ${
        selected ? 'bg-white/20 text-white' : 'bg-subtle text-ink-soft'
      }`}
    >
      {count}
    </span>
  );
}

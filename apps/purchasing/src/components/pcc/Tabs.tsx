// Tabs.
//
// URL-driven, not state-driven. A purchasing manager who is looking at "Ready
// to order" must be able to send that link to a colleague, reload it, and come
// back to it from the browser's back button — none of which a useState tab
// gives you. It also keeps the whole surface a server component.
import Link from 'next/link';

export type TabItem = {
  key: string;
  label: string;
  count?: number;
  /** A dot beside the label when a human is the blocker on this pile. */
  actionable?: boolean;
};

export function Tabs({
  items,
  active,
  hrefFor,
  ariaLabel,
  className = '',
}: {
  items: TabItem[];
  active: string;
  hrefFor: (key: string) => string;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 ${className}`}
    >
      {items.map((item) => {
        const selected = item.key === active;
        return (
          <Link
            key={item.key}
            role="tab"
            aria-selected={selected}
            href={hrefFor(item.key)}
            className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md border px-3 py-2 text-sm font-medium transition ${
              selected
                ? 'border-action bg-action text-white shadow-sm'
                : 'border-line bg-surface text-ink-soft hover:border-line-strong hover:bg-subtle'
            }`}
          >
            <span>
              {item.label}
              {item.actionable && !selected && (item.count ?? 0) > 0 ? (
                <span className="ml-1 text-danger" aria-label="needs attention">
                  •
                </span>
              ) : null}
            </span>
            {typeof item.count === 'number' ? (
              <span
                className={`inline-flex min-w-6 justify-center rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums ${
                  selected ? 'bg-white/20 text-white' : 'bg-subtle text-ink-soft'
                }`}
              >
                {item.count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}

/** Section tabs inside a detail page (Items / Receiving / Activity / Documents). */
export function SubTabs({
  items,
  active,
  hrefFor,
  ariaLabel,
}: {
  items: TabItem[];
  active: string;
  hrefFor: (key: string) => string;
  ariaLabel: string;
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="flex gap-4 overflow-x-auto border-b border-line">
      {items.map((item) => {
        const selected = item.key === active;
        return (
          <Link
            key={item.key}
            role="tab"
            aria-selected={selected}
            href={hrefFor(item.key)}
            className={`-mb-px whitespace-nowrap border-b-2 px-1 py-2 text-sm font-medium transition ${
              selected ? 'border-action text-action' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {item.label}
            {typeof item.count === 'number' ? <span className="ml-1.5 tabular-nums text-muted">{item.count}</span> : null}
          </Link>
        );
      })}
    </div>
  );
}

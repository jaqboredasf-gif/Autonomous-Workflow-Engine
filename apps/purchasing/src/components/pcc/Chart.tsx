// ---------------------------------------------------------------------------
// Chart.tsx — the only drawing primitive in the product.
//
// PRESENTATION ONLY. It receives a computed series and draws it. It does not
// fetch, aggregate, decide what counts as spend, or fill a gap. Every one of
// those questions is answered in domain/dashboard.mjs, where both providers
// share the answer and a test can reach it.
//
// NO CHARTING DEPENDENCY, for the same reason the PDF writer has none: this has
// to build on a workshop PC with no network, and a chart library is a large,
// versioned, client-side answer to a problem that is forty lines of SVG.
//
// THREE THINGS A DATA PICTURE MUST DO, AND USUALLY DOES NOT:
//
//   1. SAY WHAT IT IS TO A SCREEN READER. A bar chart with no text alternative
//      is a picture of data, which is to say not data at all. Every series
//      renders a real <table> beside the drawing, visually hidden, carrying the
//      same numbers. Nothing is available to a sighted user and withheld from
//      anybody else.
//   2. NOT CARRY MEANING IN COLOUR ALONE. Values are labelled. Colour separates
//      bars; it never encodes what they mean.
//   3. DISTINGUISH "NOTHING HAPPENED" FROM "NO DATA". A month with no purchases
//      draws as an explicit gap, not as a bar of height zero — those are
//      different facts and a chart that conflates them is lying quietly. This
//      is the whole reason the domain reports `hasData` separately from a
//      total of 0.
// ---------------------------------------------------------------------------

export type SeriesPoint = {
  /** Axis label, already formatted for a person. */
  label: string;
  /** The magnitude. Ignored when `hasData` is false. */
  value: number;
  /** The value as the reader should see it — "$1,240.00", "18 lines". */
  display: string;
  /** False when there is nothing to report for this bucket, as opposed to zero. */
  hasData?: boolean;
};

/**
 * A bar series.
 *
 * Sized in a viewBox and stretched to its container, so it is responsive
 * without measuring anything and without a client component.
 */
export function BarSeries({
  points,
  caption,
  emptyMessage = 'Nothing recorded in this period.',
}: {
  points: SeriesPoint[];
  /** What the chart is, in a sentence. Becomes the accessible name and the table caption. */
  caption: string;
  emptyMessage?: string;
}) {
  const withData = points.filter((p) => p.hasData !== false);
  const peak = Math.max(0, ...withData.map((p) => Number(p.value) || 0));

  if (withData.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted">{emptyMessage}</p>
    );
  }

  return (
    <figure className="m-0">
      {/*
        aria-hidden on the drawing and a real table underneath: one set of
        numbers, reachable two ways. Duplicating them into an aria-label would
        be a second copy to keep in step.
      */}
      <div aria-hidden className="flex items-end gap-1.5" style={{ height: 132 }}>
        {points.map((point, index) => {
          const missing = point.hasData === false;
          const value = Number(point.value) || 0;
          // A real but tiny value still gets a visible sliver: a bar that
          // rounds to nothing reads as no bar, which is the other fact.
          const heightPct = missing || peak === 0 ? 0 : Math.max(2, (value / peak) * 100);
          return (
            <div key={`${point.label}-${index}`} className="flex min-w-0 flex-1 flex-col justify-end gap-1">
              <span className="truncate text-center text-[10px] tabular-nums text-muted">
                {missing ? '—' : point.display}
              </span>
              {missing ? (
                // The gap, drawn as a gap. A dashed baseline says "we have no
                // record here" in a way an empty column cannot be mistaken for.
                <span className="block border-b border-dashed border-line" style={{ height: 2 }} />
              ) : (
                <span
                  className="block rounded-t bg-accent/80"
                  style={{ height: `${heightPct}%`, minHeight: 2 }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div aria-hidden className="mt-1 flex gap-1.5">
        {points.map((point, index) => (
          <span key={`${point.label}-axis-${index}`} className="min-w-0 flex-1 truncate text-center text-[10px] text-muted">
            {point.label}
          </span>
        ))}
      </div>

      {/* The same numbers, for anybody the drawing does not serve. */}
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Period</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point, index) => (
            <tr key={`${point.label}-row-${index}`}>
              <th scope="row">{point.label}</th>
              <td>{point.hasData === false ? 'No purchases recorded' : point.display}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/**
 * One measured number, with the size of the sample it came from.
 *
 * The sample size is not decoration. "14 days" from two lines is an anecdote
 * and "14 days" from two hundred is a fact, and a reader deciding whether to
 * act on it is entitled to know which. `null` renders as "not enough data"
 * rather than as a zero, because a stage nothing has completed has no duration.
 */
export function MetricStat({
  label,
  value,
  unit = null,
  samples = null,
  hint = null,
}: {
  label: string;
  value: number | string | null;
  unit?: string | null;
  samples?: number | null;
  hint?: string | null;
}) {
  const known = value !== null && value !== undefined && value !== '';
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums text-ink">
        {known ? value : <span className="text-base font-normal text-muted">Not enough data</span>}
        {known && unit ? <span className="ml-1 text-sm font-normal text-muted">{unit}</span> : null}
      </p>
      {known && samples !== null ? (
        <p className="text-[11px] text-muted">
          from {samples} {samples === 1 ? 'line' : 'lines'}
        </p>
      ) : null}
      {hint ? <p className="text-[11px] text-muted">{hint}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The one chart on the dashboard that answers "how much of what, right now".
// ---------------------------------------------------------------------------

export type DonutSlice = {
  key: string;
  label: string;
  count: number;
  /** Where clicking this slice's legend row goes. */
  href?: string | null;
};

/**
 * Today's workload, as a donut with a legend that is the real control.
 *
 * A DONUT RATHER THAN A PIE, for a plain reason: the middle is where the total
 * goes, and the total is the number the purchaser actually reads first. A pie
 * spends that space on ink.
 *
 * THE LEGEND IS THE INTERFACE. Arc segments are small, awkward targets and
 * unreadable when a slice is two percent, so every category is a row with its
 * name, its count and a link — the drawing is the summary and the legend is
 * how you act on it. That also means nothing is conveyed by colour alone.
 *
 * A workload of nothing draws no ring and says so in words. An empty circle
 * would be a picture of a quiet morning that looks exactly like a broken one.
 */
export function WorkloadDonut({
  slices,
  total,
  caption,
  emptyMessage = 'No active purchasing work today.',
}: {
  slices: DonutSlice[];
  total: number;
  caption: string;
  emptyMessage?: string;
}) {
  if (!total) {
    return (
      <div className="py-6 text-center">
        <p className="text-sm font-medium text-ink">{emptyMessage}</p>
        <p className="mt-0.5 text-xs text-muted">New requests appear here as soon as they are submitted.</p>
      </div>
    );
  }

  // Stroke-dasharray on one circle per slice: no path arithmetic, no library,
  // and it degrades to a plain ring if the browser is ancient.
  const RADIUS = 42;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
  let offset = 0;

  return (
    <figure className="m-0 flex flex-wrap items-center gap-4">
      <div aria-hidden className="relative shrink-0" style={{ width: 128, height: 128 }}>
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
          <circle cx="50" cy="50" r={RADIUS} fill="none" strokeWidth="14" className="stroke-subtle" />
          {slices.map((slice, index) => {
            if (!slice.count) return null;
            const length = (slice.count / total) * CIRCUMFERENCE;
            const circle = (
              <circle
                key={slice.key}
                cx="50"
                cy="50"
                r={RADIUS}
                fill="none"
                strokeWidth="14"
                className={DONUT_STROKES[index % DONUT_STROKES.length]}
                strokeDasharray={`${length} ${CIRCUMFERENCE - length}`}
                strokeDashoffset={-offset}
              />
            );
            offset += length;
            return circle;
          })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-semibold tabular-nums text-ink">{total}</span>
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted">active</span>
        </div>
      </div>

      <ul className="min-w-40 flex-1 space-y-1">
        {slices.map((slice, index) => {
          const row = (
            <span className="flex items-baseline gap-2">
              <span
                aria-hidden
                className={`mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${DONUT_FILLS[index % DONUT_FILLS.length]}`}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-ink-soft">{slice.label}</span>
              <span className="shrink-0 text-sm font-semibold tabular-nums text-ink">{slice.count}</span>
            </span>
          );
          return (
            <li key={slice.key}>
              {slice.href ? (
                <a href={slice.href} className="block rounded px-1 py-0.5 hover:bg-subtle">
                  {row}
                </a>
              ) : (
                <span className="block px-1 py-0.5">{row}</span>
              )}
            </li>
          );
        })}
      </ul>

      {/* The same numbers, for anybody the drawing does not serve. */}
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Requests</th>
          </tr>
        </thead>
        <tbody>
          {slices.map((slice) => (
            <tr key={`${slice.key}-row`}>
              <th scope="row">{slice.label}</th>
              <td>{slice.count}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">Total</th>
            <td>{total}</td>
          </tr>
        </tbody>
      </table>
    </figure>
  );
}

/**
 * Five separable tones. Brand blue leads because the first slice is the one
 * needing a decision; the rest step away from it in lightness as well as hue,
 * so the ring survives a black-and-white screenshot and a colour-blind reader.
 */
const DONUT_STROKES = ['stroke-brand', 'stroke-accent', 'stroke-info', 'stroke-success', 'stroke-line-strong'];
const DONUT_FILLS = ['bg-brand', 'bg-accent', 'bg-info', 'bg-success', 'bg-line-strong'];

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

'use client';

import { usePurchasing } from '@/lib/store-context';

/**
 * Always-on reminder that nothing here is real. Kept off printed output so a
 * printed PO does not carry the banner — the DEMO- PO number does that job.
 */
export default function DemoBanner() {
  const { actor, setActor, state } = usePurchasing();

  return (
    <div className="no-print bg-amber-400 text-amber-950">
      <div className="mx-auto flex max-w-7xl flex-col gap-1 px-4 py-2 text-xs sm:flex-row sm:items-center sm:justify-between">
        <p className="font-semibold tracking-wide">
          DEMO MODE — simulated data only. No email is sent and no order is placed.
        </p>
        <label className="flex items-center gap-2">
          <span className="font-medium">Acting as</span>
          <select
            aria-label="Acting as"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            className="rounded border border-amber-700/40 bg-amber-50 px-2 py-1 font-medium"
          >
            {state.requestors.map((r) => (
              <option key={r.id} value={r.name}>
                {r.name} — {r.role}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

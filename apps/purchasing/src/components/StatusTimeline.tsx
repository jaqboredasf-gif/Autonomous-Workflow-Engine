import { TIMELINE_STEPS } from '@/lib/status';
import type { RequestStatus } from '@/lib/types';

/**
 * Happy-path progress. Rejected and Canceled are off the line entirely — they
 * end the request rather than advance it, so we say that plainly.
 */
export default function StatusTimeline({ status }: { status: RequestStatus }) {
  if (status === 'Rejected' || status === 'Canceled') {
    return (
      <div className="rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-700">
        This request was <strong>{status.toLowerCase()}</strong> and is closed. Raise a new
        request if the material is still needed.
      </div>
    );
  }

  const current = TIMELINE_STEPS.indexOf(status);

  return (
    <ol className="flex flex-wrap items-center gap-y-3">
      {TIMELINE_STEPS.map((step, i) => {
        // Completed is the end of the line — show it checked, not "in progress".
        const done = i < current || (status === 'Completed' && i === current);
        const active = i === current && status !== 'Completed';
        return (
          <li key={step} className="flex items-center">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                  done
                    ? 'bg-emerald-600 text-white'
                    : active
                      ? 'bg-blue-700 text-white'
                      : 'bg-neutral-200 text-neutral-500'
                }`}
              >
                {done ? '✓' : i + 1}
              </span>
              <span
                className={`text-xs font-medium ${
                  active ? 'text-neutral-900' : done ? 'text-neutral-700' : 'text-neutral-400'
                }`}
              >
                {step}
              </span>
            </div>
            {i < TIMELINE_STEPS.length - 1 && (
              <span
                aria-hidden
                className={`mx-2 h-px w-6 ${done ? 'bg-emerald-500' : 'bg-neutral-200'}`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

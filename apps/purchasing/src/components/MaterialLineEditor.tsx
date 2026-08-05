'use client';

import { inputClass, errorInputClass } from './Field';
import { newLine } from '@/lib/store';
import type { MaterialLine } from '@/lib/types';

export default function MaterialLineEditor({
  lines,
  errors,
  listError,
  onChange,
}: {
  lines: MaterialLine[];
  errors: Record<string, string>;
  listError?: string;
  onChange: (lines: MaterialLine[]) => void;
}) {
  function update(id: string, patch: Partial<MaterialLine>) {
    onChange(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  }

  return (
    <section className="rounded-lg border border-neutral-200 bg-white">
      <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-900">
            Material items <span className="text-red-600">*</span>
          </h2>
          <p className="text-xs text-neutral-500">
            One request can carry as many line items as you need — all for the same job and vendor.
          </p>
        </div>
        <button
          type="button"
          onClick={() => onChange([...lines, newLine()])}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
        >
          + Add row
        </button>
      </div>

      {listError && (
        <p role="alert" className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs font-medium text-red-700">
          {listError}
        </p>
      )}

      {lines.length === 0 ? (
        <p className="px-4 py-6 text-sm text-neutral-500">
          No material rows yet. Add at least one.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100">
          {lines.map((line, index) => (
            <li key={line.id} className="px-4 py-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-neutral-600">
                    Qty <span className="text-red-600">*</span>
                  </label>
                  <input
                    aria-label={`Quantity for line ${index + 1}`}
                    type="number"
                    min={0}
                    step="any"
                    value={Number.isFinite(line.quantity) ? line.quantity : ''}
                    onChange={(e) => update(line.id, { quantity: Number(e.target.value) })}
                    className={`mt-1 ${inputClass} ${errors[line.id] ? errorInputClass : ''}`}
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-neutral-600">Unit</label>
                  <input
                    aria-label={`Unit for line ${index + 1}`}
                    value={line.unit}
                    onChange={(e) => update(line.id, { unit: e.target.value })}
                    placeholder="ea"
                    className={`mt-1 ${inputClass}`}
                  />
                </div>

                <div className="sm:col-span-5">
                  <label className="block text-xs font-medium text-neutral-600">
                    Description <span className="text-red-600">*</span>
                  </label>
                  <input
                    aria-label={`Description for line ${index + 1}`}
                    value={line.description}
                    onChange={(e) => update(line.id, { description: e.target.value })}
                    placeholder="1/2 in. EMT conduit, 10 ft"
                    className={`mt-1 ${inputClass} ${errors[line.id] ? errorInputClass : ''}`}
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-neutral-600">
                    Stock no.{' '}
                    <span className="font-normal text-neutral-400">(optional)</span>
                  </label>
                  <input
                    aria-label={`Stock number for line ${index + 1}`}
                    value={line.stockNumber ?? ''}
                    onChange={(e) => update(line.id, { stockNumber: e.target.value })}
                    className={`mt-1 ${inputClass}`}
                  />
                </div>

                <div className="flex items-end sm:col-span-1">
                  <button
                    type="button"
                    aria-label={`Remove line ${index + 1}`}
                    onClick={() => onChange(lines.filter((l) => l.id !== line.id))}
                    className="w-full rounded-md border border-neutral-300 px-2 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
                  >
                    Remove
                  </button>
                </div>
              </div>

              {errors[line.id] && (
                <p role="alert" className="mt-1 text-xs font-medium text-red-600">
                  {errors[line.id]}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

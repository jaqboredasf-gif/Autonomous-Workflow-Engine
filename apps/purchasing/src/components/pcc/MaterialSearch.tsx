'use client';
// Material autocomplete for the request form.
//
// Suggestions come from what the organization has ALREADY bought, ranked by
// how often and how recently (domain/catalog.mjs). Choosing one fills the
// description and the unit and records the catalog key alongside — so the same
// item typed three ways still collapses to one line of history, which is the
// substrate every later feature (preferred vendor, price history, reorder)
// needs.
//
// FREE TEXT IS ALWAYS ALLOWED. The catalogue is a convenience, not a gate: a
// person holding a part nobody has ordered before types it and carries on.
import { useEffect, useId, useRef, useState } from 'react';

import { fieldStyle } from './Input';
import { formatQty } from '../../purchasing/domain/numbers.mjs';

type Suggestion = {
  id: string | null;
  key: string;
  description: string;
  unit: string | null;
  catalogNumber: string | null;
  timesRequested: number;
  completedOrderCount: number;
  commonQuantity: number | null;
  lastOrderedAt: string | null;
};

export function MaterialSearch({
  value,
  onChange,
  onPick,
  name = 'itemDescription',
  catalogKeyName = 'itemCatalogKey',
  placeholder = 'e.g. 2x4 LED troffer, 4000K',
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  onPick?: (suggestion: Suggestion) => void;
  name?: string;
  catalogKeyName?: string;
  placeholder?: string;
  id?: string;
}) {
  const listId = useId();
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string>('');
  const boxRef = useRef<HTMLDivElement>(null);

  // Debounced, and aborted when the query moves on: a person typing a long
  // description should not leave eight requests racing to answer.
  useEffect(() => {
    const query = value.trim();
    if (query.length < 2) {
      setItems([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/materials/suggest?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const body = await res.json();
        setItems(Array.isArray(body.items) ? body.items : []);
      } catch {
        // An aborted or failed suggestion is not an error a requester should
        // see. Free text still works.
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value]);

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, []);

  const choose = (suggestion: Suggestion) => {
    onChange(suggestion.description);
    setPicked(suggestion.key);
    setOpen(false);
    onPick?.(suggestion);
  };

  const visible = open && items.length > 0;

  return (
    <div ref={boxRef} className="relative">
      {/* The catalog key travels with the line. It is the NORMALIZED form the
          domain matched on, never a display string, and the server re-derives
          it from the description anyway — this only records that the person
          picked a known item rather than typing a near-miss. */}
      <input type="hidden" name={catalogKeyName} value={picked} />
      <input
        id={id}
        name={name}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setPicked('');
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={visible}
        aria-controls={listId}
        aria-autocomplete="list"
        className={fieldStyle()}
      />

      {visible ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-pop"
        >
          {items.map((item) => (
            <li key={item.key} role="option" aria-selected={picked === item.key}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(item)}
                className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-action-soft"
              >
                <span className="min-w-0 truncate text-ink">{item.description}</span>
                <span className="shrink-0 text-right text-xs text-muted">
                  <span className="block">
                    {item.unit ? `${item.unit} · ` : ''}
                    {item.completedOrderCount > 0 ? `${item.completedOrderCount} completed order(s)` : 'catalogued'}
                  </span>
                  {item.lastOrderedAt ? (
                    <span className="block">
                      last {item.lastOrderedAt.slice(0, 10)}
                      {item.commonQuantity === null ? '' : ` · common qty ${formatQty(item.commonQuantity)}`}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {picked ? (
        <p className="mt-1 text-xs text-muted">Historical values are a starting point for this new request only.</p>
      ) : null}
    </div>
  );
}

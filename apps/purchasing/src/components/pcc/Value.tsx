// Formatted values. Money and quantity are stored as integers (cents,
// thousandths) and must never be formatted ad hoc in a screen — the domain's
// formatters are the only ones that know the scale.
import { formatMoney, formatQty } from '../../purchasing/domain/numbers.mjs';

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

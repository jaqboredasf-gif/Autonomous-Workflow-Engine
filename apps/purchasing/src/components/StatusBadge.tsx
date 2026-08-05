import { STATUS_STYLES } from '@/lib/status';
import type { RequestStatus } from '@/lib/types';

export default function StatusBadge({ status }: { status: RequestStatus }) {
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

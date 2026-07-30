// ---------------------------------------------------------------------------
// adapters/types.ts — the shape every capability adapter returns.
//
// Adapters translate ONE capability into Graph calls and back. They do not
// authorize, do not retry, do not write evidence and do not know what an
// approval is — all of that belongs to the executor. Keeping them this dumb is
// what makes the Microsoft provider replaceable: a different provider ships a
// different set of adapters and nothing above the seam changes.
// ---------------------------------------------------------------------------

import type { FailureReason } from '../contracts.ts';

export interface AdapterSuccess<T> {
  readonly ok: true;
  readonly data: T;
  /** Microsoft ids worth keeping in the audit trail, keyed by role. */
  readonly microsoftResourceIds: Readonly<Record<string, string>>;
  /** Raw provider body, hashed (not stored) by the evidence writer. */
  readonly raw: unknown;
}

export interface AdapterFailure {
  readonly ok: false;
  readonly failureReason: FailureReason;
  readonly detail: string;
  /** Whether the executor may spend another attempt on this. */
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly raw: unknown;
}

export type AdapterResult<T> = AdapterSuccess<T> | AdapterFailure;

import type { GraphResponse } from '../gateway.ts';
import { isRetryableStatus, isThrottled } from '../gateway.ts';

/** Map a non-2xx Graph response onto the failure vocabulary, once, in one place. */
export function failureFromResponse(res: GraphResponse<unknown>): AdapterFailure {
  const detail = describeGraphError(res);
  if (isThrottled(res.status)) {
    return { ok: false, failureReason: 'provider_throttled', detail, retryable: true, retryAfterSeconds: res.retryAfterSeconds, raw: res.body };
  }
  if (res.status === 504 || res.status === 408) {
    return { ok: false, failureReason: 'provider_timeout', detail, retryable: true, retryAfterSeconds: res.retryAfterSeconds, raw: res.body };
  }
  if (isRetryableStatus(res.status)) {
    return { ok: false, failureReason: 'provider_unavailable', detail, retryable: true, retryAfterSeconds: res.retryAfterSeconds, raw: res.body };
  }
  if (res.status === 404) {
    return { ok: false, failureReason: 'resource_not_found', detail, retryable: false, retryAfterSeconds: null, raw: res.body };
  }
  return { ok: false, failureReason: 'provider_error', detail, retryable: false, retryAfterSeconds: null, raw: res.body };
}

export function describeGraphError(res: GraphResponse<unknown>): string {
  const e = (res as unknown as { error?: { code?: string; message?: string } }).error;
  const code = e?.code ?? 'unknown';
  const message = e?.message ?? '';
  return `graph ${res.status} ${code}${message ? `: ${message}` : ''}`;
}

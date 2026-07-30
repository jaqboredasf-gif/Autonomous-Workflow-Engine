// ---------------------------------------------------------------------------
// gateway.ts — MicrosoftGraphGateway: the transport seam.
//
// This is the ONLY interface in the package that speaks HTTP. Adapters express
// intent in Graph terms (method, path, body); the gateway decides how that
// becomes a request, or whether it becomes one at all. Two implementations ship:
//
//   FakeGraphGateway  (fake-graph.ts) — deterministic, offline, always tagged
//                     fidelity: 'synthetic'.
//   HttpGraphGateway  (http-gateway.ts) — real Graph, disabled by default,
//                     refuses to run without credentials + an explicit opt-in.
//
// Separating transport from execution semantics is the whole point: the executor
// never learns what a 429 is, and the gateway never learns what an approval is.
// ---------------------------------------------------------------------------

import type { ProviderFidelity } from './contracts.ts';

export type GraphMethod = 'GET' | 'POST' | 'PATCH' | 'PUT';

export interface GraphRequest {
  readonly method: GraphMethod;
  /** Graph path WITHOUT host or version prefix, e.g. `/users/x@y/messages/AAmk`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Scopes this call runs under. The gateway asserts the token carries them. */
  readonly scopes: readonly string[];
  readonly correlationId: string;
  /** Graph honours this for POST/PATCH de-duplication; we also key our own ledger on it. */
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
}

export interface GraphResponse<T = unknown> {
  readonly status: number;
  readonly ok: boolean;
  readonly body: T | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly fidelity: ProviderFidelity;
  /** Graph's own request id, kept for support escalations. */
  readonly requestId: string | null;
  /** Seconds Graph asked us to wait, when it throttled. */
  readonly retryAfterSeconds: number | null;
}

/**
 * The gateway contract. Implementations MUST:
 *   * never retry internally (retry bounds belong to the executor, which owns
 *     idempotency and evidence),
 *   * never throw for an HTTP-level failure — return the response,
 *   * report fidelity honestly.
 */
export interface MicrosoftGraphGateway {
  readonly fidelity: ProviderFidelity;
  execute<T = unknown>(request: GraphRequest): Promise<GraphResponse<T>>;
}

/** HTTP statuses worth another attempt. Everything else is a decision, not a blip. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

export function isThrottled(status: number): boolean {
  return status === 429;
}

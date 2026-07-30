// Minimal ambient declarations for the two Node built-ins this package touches.
//
// Why not @types/node: this package deliberately has ZERO dependencies (it is the
// provider plane — the thing most likely to be audited), and the repo installs no
// workspace dev dependencies for the offline runners. `tsconfig.json` sets
// `"types": []` so nothing here can collide with an installed @types/node.
//
// Only the surface actually used is declared. Adding an API here is a conscious
// act, which is the point.

declare module 'node:crypto' {
  export interface Hash {
    update(data: string): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: 'sha256'): Hash;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare module 'node:buffer' {
  export const Buffer: {
    from(input: string, encoding?: 'utf8' | 'base64'): Uint8Array & { toString(encoding?: 'utf8' | 'base64'): string; length: number };
    byteLength(input: string, encoding?: 'utf8' | 'base64'): number;
  };
}

declare const process: {
  env: Record<string, string | undefined>;
};

// The web-platform globals used by the LIVE transport only (http-gateway.ts).
// Nothing in the deterministic core touches these — which is exactly why they
// are declared here in a block of their own rather than pulled in wholesale.

declare class URLSearchParams {
  constructor(init?: Record<string, string>);
  toString(): string;
}

declare class AbortController {
  readonly signal: unknown;
  abort(): void;
}

declare function setTimeout(handler: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;

interface FetchHeaders {
  get(name: string): string | null;
  entries(): Iterable<[string, string]>;
}

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: FetchHeaders;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | URLSearchParams | undefined;
  signal?: unknown;
}

declare function fetch(input: string, init?: FetchInit): Promise<FetchResponse>;

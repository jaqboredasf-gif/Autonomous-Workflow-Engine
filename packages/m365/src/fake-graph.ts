// ---------------------------------------------------------------------------
// fake-graph.ts — the deterministic fake Microsoft Graph provider.
//
// This is a TEST DOUBLE and says so in every response: `fidelity: 'synthetic'`.
// It exists so the whole integration plane — gates, retries, idempotency,
// evidence — can be verified without credentials, admin consent, a public
// webhook endpoint, or a single packet leaving the machine.
//
// Properties that make it useful rather than decorative:
//   * Deterministic. No clock, no randomness. Ids of created artifacts are
//     derived from the idempotency key, so the SAME create twice yields the same
//     id and does NOT create a second artifact — the fake enforces the same
//     contract Graph does, which is what makes the duplicate-delivery test real.
//   * Bounded. Its world is exactly the fixture state it was given. A request for
//     a mailbox it does not know returns 404, not an invented message.
//   * Faultable. Scripted faults (429 with Retry-After, 503, 504, 500) drive the
//     retry and partial-failure tests deterministically.
//   * Honest. It cannot produce fidelity 'live'; the field is a literal.
//
// It is NOT a Graph emulator. It implements the handful of routes the capability
// catalog actually uses, and returns 501 for anything else — an unimplemented
// route must fail loudly rather than quietly succeed.
// ---------------------------------------------------------------------------

import type { GraphRequest, GraphResponse, MicrosoftGraphGateway } from './gateway.ts';
import { hashValue } from './evidence.ts';

export interface FakeGraphMessage {
  readonly id: string;
  readonly internetMessageId: string;
  readonly conversationId: string;
  readonly subject: string;
  readonly bodyPreview?: string;
  readonly body: { readonly contentType: 'text' | 'html'; readonly content: string };
  readonly from: { readonly emailAddress: { readonly address: string; readonly name?: string } };
  readonly toRecipients: readonly { readonly emailAddress: { readonly address: string; readonly name?: string } }[];
  readonly ccRecipients?: readonly { readonly emailAddress: { readonly address: string; readonly name?: string } }[];
  readonly receivedDateTime: string;
  readonly hasAttachments: boolean;
}

export interface FakeGraphAttachment {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly isInline: boolean;
  /** base64, exactly as Graph returns it for a fileAttachment. */
  readonly contentBytes: string;
}

export interface FakeGraphUser {
  readonly id: string;
  readonly userPrincipalName: string;
  readonly displayName: string;
}

export interface FakeGraphState {
  readonly tenantId: string;
  readonly users: readonly FakeGraphUser[];
  readonly mailboxes: Readonly<Record<string, {
    readonly messages: readonly FakeGraphMessage[];
    readonly attachments: Readonly<Record<string, readonly FakeGraphAttachment[]>>;
  }>>;
  readonly teamsChannels: readonly { readonly id: string; readonly teamId: string; readonly displayName: string }[];
  readonly sharepointLibraries: readonly { readonly id: string; readonly siteId: string; readonly name: string }[];
}

export interface ScriptedFault {
  readonly method: string;
  /** Substring match against the request path — simple on purpose. */
  readonly pathContains: string;
  readonly status: number;
  /** How many consecutive times to serve this fault before letting the call through. */
  readonly times: number;
  readonly retryAfterSeconds?: number;
  readonly message?: string;
}

export interface FakeGraphOptions {
  readonly faults?: readonly ScriptedFault[];
}

export interface FakeGraphGateway extends MicrosoftGraphGateway {
  /** Everything the fake was asked to do, in order — the transport-level log. */
  readonly calls: readonly { readonly method: string; readonly path: string; readonly idempotencyKey: string }[];
  /** Artifacts the fake created, so tests can assert "exactly one draft exists". */
  readonly created: readonly { readonly kind: 'draft' | 'teams_message' | 'drive_item'; readonly id: string; readonly idempotencyKey: string; readonly target: string }[];
}

const json = <T>(status: number, body: T, extra: Partial<GraphResponse<T>> = {}): GraphResponse<T> => ({
  status,
  ok: status >= 200 && status < 300,
  body,
  headers: {},
  fidelity: 'synthetic',
  requestId: null,
  retryAfterSeconds: null,
  ...extra,
});

const err = (status: number, code: string, message: string, retryAfterSeconds: number | null = null): GraphResponse<never> => ({
  status,
  ok: false,
  body: null,
  headers: retryAfterSeconds != null ? { 'retry-after': String(retryAfterSeconds) } : {},
  fidelity: 'synthetic',
  requestId: null,
  retryAfterSeconds,
  // The error shape mirrors Graph's own so adapters parse the real thing.
  ...({ error: { code, message } } as object),
});

/** Deterministic artifact id: same idempotency key => same id, always. */
function derivedId(prefix: string, idempotencyKey: string, target: string): string {
  return `${prefix}_${hashValue({ k: idempotencyKey, t: target }).slice(0, 32)}`;
}

export function createFakeGraphGateway(state: FakeGraphState, options: FakeGraphOptions = {}): FakeGraphGateway {
  const calls: { method: string; path: string; idempotencyKey: string }[] = [];
  const created: { kind: 'draft' | 'teams_message' | 'drive_item'; id: string; idempotencyKey: string; target: string }[] = [];
  // Mutable copy of the fault script; each serving decrements `remaining`.
  const faults = (options.faults ?? []).map((f) => ({ ...f, remaining: f.times }));

  const nextFault = (req: GraphRequest) =>
    faults.find((f) => f.remaining > 0 && f.method === req.method && req.path.includes(f.pathContains));

  const mailbox = (upn: string) => {
    const key = Object.keys(state.mailboxes).find((k) => k.toLowerCase() === upn.toLowerCase());
    return key ? { key, box: state.mailboxes[key]! } : null;
  };

  const gateway: FakeGraphGateway = {
    fidelity: 'synthetic',
    calls,
    created,

    async execute<T>(request: GraphRequest): Promise<GraphResponse<T>> {
      calls.push({ method: request.method, path: request.path, idempotencyKey: request.idempotencyKey });

      const fault = nextFault(request);
      if (fault) {
        fault.remaining -= 1;
        return err(
          fault.status,
          fault.status === 429 ? 'tooManyRequests' : 'serviceError',
          fault.message ?? 'scripted fault',
          fault.retryAfterSeconds ?? null,
        ) as GraphResponse<T>;
      }

      const path = request.path.replace(/^\//, '');
      const parts = path.split('/');

      // GET /users/{upn}
      if (request.method === 'GET' && parts[0] === 'users' && parts.length === 2) {
        const upn = decodeURIComponent(parts[1]!);
        const user = state.users.find((u) => u.userPrincipalName.toLowerCase() === upn.toLowerCase() || u.id === upn);
        return (user
          ? json(200, user)
          : err(404, 'ResourceNotFound', `no user '${upn}'`)) as GraphResponse<T>;
      }

      // GET /users/{upn}/messages/{id}
      if (request.method === 'GET' && parts[0] === 'users' && parts[2] === 'messages' && parts.length === 4) {
        const found = mailbox(decodeURIComponent(parts[1]!));
        if (!found) return err(404, 'ResourceNotFound', `no mailbox '${parts[1]}'`) as GraphResponse<T>;
        const msg = found.box.messages.find((m) => m.id === parts[3]);
        return (msg
          ? json(200, msg)
          : err(404, 'ErrorItemNotFound', `no message '${parts[3]}'`)) as GraphResponse<T>;
      }

      // GET /users/{upn}/messages/{id}/attachments
      if (request.method === 'GET' && parts[0] === 'users' && parts[2] === 'messages' && parts[4] === 'attachments' && parts.length === 5) {
        const found = mailbox(decodeURIComponent(parts[1]!));
        if (!found) return err(404, 'ResourceNotFound', `no mailbox '${parts[1]}'`) as GraphResponse<T>;
        // The manifest is metadata only — the adapter asks for exactly these
        // fields with $select, and real Graph honours it. Bytes are served by
        // the per-attachment route below, under its own capability.
        const list = (found.box.attachments[parts[3]!] ?? []).map(
          ({ contentBytes: _bytes, ...meta }) => meta,
        );
        return json(200, { value: list }) as GraphResponse<T>;
      }

      // GET /users/{upn}/messages/{id}/attachments/{aid}
      if (request.method === 'GET' && parts[0] === 'users' && parts[2] === 'messages' && parts[4] === 'attachments' && parts.length === 6) {
        const found = mailbox(decodeURIComponent(parts[1]!));
        if (!found) return err(404, 'ResourceNotFound', `no mailbox '${parts[1]}'`) as GraphResponse<T>;
        const att = (found.box.attachments[parts[3]!] ?? []).find((a) => a.id === parts[5]);
        return (att
          ? json(200, att)
          : err(404, 'ErrorItemNotFound', `no attachment '${parts[5]}'`)) as GraphResponse<T>;
      }

      // POST /users/{upn}/messages  — CREATE A DRAFT. Graph's create-message
      // route produces an unsent draft in the Drafts folder; there is no /send
      // route implemented in this fake, deliberately, so a send cannot even be
      // simulated.
      if (request.method === 'POST' && parts[0] === 'users' && parts[2] === 'messages' && parts.length === 3) {
        const found = mailbox(decodeURIComponent(parts[1]!));
        if (!found) return err(404, 'ResourceNotFound', `no mailbox '${parts[1]}'`) as GraphResponse<T>;
        const id = derivedId('AAMkDRAFT', request.idempotencyKey, found.key);
        const already = created.find((c) => c.kind === 'draft' && c.id === id);
        if (!already) created.push({ kind: 'draft', id, idempotencyKey: request.idempotencyKey, target: found.key });
        const body = request.body as { subject?: string; toRecipients?: unknown[] } | undefined;
        return json(already ? 200 : 201, {
          id,
          isDraft: true,
          subject: body?.subject ?? null,
          webLink: `https://outlook.office.invalid/mail/drafts/id/${id}`,
          parentFolderId: 'drafts',
        }) as GraphResponse<T>;
      }

      // POST /teams/{teamId}/channels/{channelId}/messages
      if (request.method === 'POST' && parts[0] === 'teams' && parts[2] === 'channels' && parts[4] === 'messages' && parts.length === 5) {
        const channel = state.teamsChannels.find((c) => c.teamId === parts[1] && c.id === parts[3]);
        if (!channel) return err(404, 'ResourceNotFound', `no channel '${parts[3]}'`) as GraphResponse<T>;
        const id = derivedId('TEAMSMSG', request.idempotencyKey, channel.id);
        const already = created.find((c) => c.kind === 'teams_message' && c.id === id);
        if (!already) created.push({ kind: 'teams_message', id, idempotencyKey: request.idempotencyKey, target: channel.id });
        return json(already ? 200 : 201, {
          id,
          webUrl: `https://teams.microsoft.invalid/l/message/${channel.id}/${id}`,
          channelIdentity: { teamId: channel.teamId, channelId: channel.id },
        }) as GraphResponse<T>;
      }

      // PUT /drives/{driveId}/items/root:/{path}:/content  — upload one file.
      if (request.method === 'PUT' && parts[0] === 'drives' && parts[2] === 'items' && path.includes(':/') && path.endsWith(':/content')) {
        const library = state.sharepointLibraries.find((l) => l.id === parts[1]);
        if (!library) return err(404, 'ResourceNotFound', `no drive '${parts[1]}'`) as GraphResponse<T>;
        const id = derivedId('DRIVEITEM', request.idempotencyKey, library.id);
        const already = created.find((c) => c.kind === 'drive_item' && c.id === id);
        if (!already) created.push({ kind: 'drive_item', id, idempotencyKey: request.idempotencyKey, target: library.id });
        const name = decodeURIComponent(path.split(':/')[1]?.replace(/:\/content$/, '') ?? 'file.bin');
        return json(already ? 200 : 201, {
          id,
          name,
          webUrl: `https://contoso.sharepoint.invalid/${library.name}/${name}`,
          parentReference: { driveId: library.id, siteId: library.siteId },
        }) as GraphResponse<T>;
      }

      return err(501, 'NotImplemented', `fake graph has no route for ${request.method} /${path}`) as GraphResponse<T>;
    },
  };

  return gateway;
}

// ---------------------------------------------------------------------------
// adapters/document.ts — MicrosoftDocumentAdapter.
//
// Stores one artifact in ONE allowlisted SharePoint development library. The
// upload path is deterministic and namespaced by objective, so re-running a
// slice overwrites its own file rather than littering the library with copies —
// and, crucially, cannot write outside its own prefix.
//
// No delete, no move, no permission change, no site enumeration. Sites.Selected
// means an administrator grants the app access to exactly the sites they choose;
// this adapter is the narrow use of that grant.
// ---------------------------------------------------------------------------

import type { MicrosoftGraphGateway } from '../gateway.ts';
import type { AdapterCallContext } from './mail.ts';
import type { AdapterResult } from './types.ts';
import { failureFromResponse } from './types.ts';

export interface DocumentTarget {
  readonly driveId: string;
  readonly siteId: string;
  /** Folder prefix inside the library this integration may write to. */
  readonly rootPath: string;
}

export interface DocumentSpec {
  readonly objectiveId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly contentBase64: string;
  readonly contentHash: string;
}

export interface StoredDocument {
  readonly driveItemId: string;
  readonly driveId: string;
  readonly siteId: string;
  readonly path: string;
  readonly webUrl: string | null;
  readonly contentHash: string;
}

export interface MicrosoftDocumentAdapter {
  store(ctx: AdapterCallContext, target: DocumentTarget, spec: DocumentSpec): Promise<AdapterResult<StoredDocument>>;
}

/**
 * Strip everything that could escape the prefix. A file name is data from an
 * untrusted email; treating it as a path is how you end up writing to `/`.
 */
export function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'attachment';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'attachment';
}

export function createDocumentAdapter(gateway: MicrosoftGraphGateway): MicrosoftDocumentAdapter {
  return {
    async store(ctx, target, spec) {
      const path = `${target.rootPath.replace(/\/+$/, '')}/${spec.objectiveId}/${safeFileName(spec.fileName)}`;
      const res = await gateway.execute<{ id?: string; webUrl?: string; name?: string }>({
        method: 'PUT',
        path: `/drives/${target.driveId}/items/root:${path}:/content`,
        body: { contentBase64: spec.contentBase64, contentType: spec.contentType },
        headers: { 'content-type': spec.contentType },
        scopes: ctx.scopes,
        correlationId: ctx.correlationId,
        idempotencyKey: ctx.idempotencyKey,
        timeoutMs: ctx.timeoutMs,
      });
      if (!res.ok || !res.body?.id) return failureFromResponse(res);
      return {
        ok: true,
        microsoftResourceIds: { driveItemId: res.body.id, driveId: target.driveId, siteId: target.siteId },
        raw: res.body,
        data: {
          driveItemId: res.body.id,
          driveId: target.driveId,
          siteId: target.siteId,
          path,
          webUrl: res.body.webUrl ?? null,
          contentHash: spec.contentHash,
        },
      };
    },
  };
}

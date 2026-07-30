// ---------------------------------------------------------------------------
// @exattime/m365 — the Microsoft 365 Integration Plane.
//
// A provider-bound but workflow-neutral gateway: it knows Microsoft Graph, and
// it knows nothing about electrical work requests, invoices or scheduling. The
// only things it exports are capabilities, gates and evidence.
//
// Layering (top depends on bottom, never the reverse):
//
//   pipeline        the first proof slice, orchestration only
//   executor        every gate, every retry, every evidence row
//   handlers        capability -> adapter binding
//   adapters        mail / teams / document / identity, transport-shaped
//   gateway         MicrosoftGraphGateway: fake (deterministic) or http (live)
//   contracts       the seam: what AWE agrees to, independent of provider
// ---------------------------------------------------------------------------

export * from './contracts.ts';
export * from './capabilities.ts';
export * from './allowlist.ts';
export * from './scopes.ts';
export * from './gateway.ts';
export * from './fake-graph.ts';
export * from './http-gateway.ts';
export * from './credentials.ts';
export * from './evidence.ts';
export * from './subscriptions.ts';
export * from './notifications.ts';
export * from './execution.ts';
export * from './policy.ts';
export * from './executor.ts';
export * from './handlers.ts';
export * from './normalize.ts';
export * from './persistence.ts';
export * from './pipeline.ts';

export type { AdapterResult, AdapterSuccess, AdapterFailure } from './adapters/types.ts';
export type { AdapterCallContext, MicrosoftMailAdapter, MailMessage, MailAttachment, DraftSpec, CreatedDraft } from './adapters/mail.ts';
export type { MicrosoftTeamsAdapter, TeamsChannelTarget, TeamsNotification, TeamsApprovalRequest, PostedTeamsMessage } from './adapters/teams.ts';
export type { MicrosoftDocumentAdapter, DocumentTarget, DocumentSpec, StoredDocument } from './adapters/document.ts';
export type { MicrosoftIdentityAdapter, ResolvedIdentity } from './adapters/identity.ts';

export { createMailAdapter } from './adapters/mail.ts';
export { createTeamsAdapter } from './adapters/teams.ts';
export { createDocumentAdapter, safeFileName } from './adapters/document.ts';
export { createIdentityAdapter } from './adapters/identity.ts';

// ---------------------------------------------------------------------------
// capabilities.ts — the workflow-neutral capability catalog.
//
// One row per approved capability, carrying its contract: least-privilege Graph
// scopes, the resource kinds it may target, its side-effect class, whether a
// human decision is mandatory, and its version. MVP_SPEC's rule holds here
// unchanged: "no side effect outside a registered tool".
//
// What is deliberately ABSENT is the point of this file:
//   * m365.mail.message.send — no such capability exists at any version. The
//     absence is the guard; the executor additionally refuses the
//     'external_send' side-effect class so a future entry cannot be added
//     without a deliberate, reviewable change to the class check.
//   * m365.mail.message.delete / move / reply — nothing mutates a real mailbox.
//   * anything tenant-wide. Every capability targets one allowlisted resource.
// ---------------------------------------------------------------------------

import type { CapabilityName, CapabilitySpec } from './contracts.ts';

export const CAPABILITY_CATALOG: readonly CapabilitySpec[] = [
  {
    name: 'm365.identity.resolve',
    version: 1,
    sideEffect: 'read',
    // Least privilege: ReadBasic.All resolves display name / UPN, and nothing
    // else. User.Read.All would also expose org-wide profile detail we never use.
    requiredScopes: ['User.ReadBasic.All'],
    resourceKinds: ['directory_user'],
    requiresApproval: false,
    idempotent: true,
    description: 'Resolve a Microsoft directory principal to a stable id + display name.',
  },
  {
    name: 'm365.mail.message.read',
    version: 1,
    sideEffect: 'read',
    requiredScopes: ['Mail.Read'],
    resourceKinds: ['message'],
    requiresApproval: false,
    idempotent: true,
    description: 'Retrieve one message from an allowlisted mailbox.',
  },
  {
    name: 'm365.mail.attachment.read',
    version: 1,
    sideEffect: 'read',
    requiredScopes: ['Mail.Read'],
    resourceKinds: ['attachment'],
    requiresApproval: false,
    idempotent: true,
    description: 'Retrieve one attachment of a message in an allowlisted mailbox.',
  },
  {
    name: 'm365.mail.draft.create',
    version: 1,
    // A draft is an internal write: it lands in the Drafts folder of an
    // allowlisted development mailbox and is never transmitted. There is no
    // /send call anywhere in this package.
    sideEffect: 'internal_write',
    requiredScopes: ['Mail.ReadWrite'],
    resourceKinds: ['mailbox'],
    requiresApproval: true,
    idempotent: true,
    description: 'Create an unsent draft in an allowlisted mailbox. Never sends.',
  },
  {
    name: 'm365.teams.notification.create',
    version: 1,
    sideEffect: 'internal_write',
    requiredScopes: ['ChannelMessage.Send'],
    resourceKinds: ['teams_channel'],
    // Internal, to an allowlisted development channel, carrying no customer
    // commitment: policy governs it, a human decision does not gate it.
    requiresApproval: false,
    idempotent: true,
    description: 'Post an internal notification to an allowlisted Teams channel.',
  },
  {
    name: 'm365.teams.approval.request',
    version: 1,
    sideEffect: 'internal_write',
    requiredScopes: ['ChannelMessage.Send'],
    resourceKinds: ['teams_channel'],
    // This capability ASKS for an approval; requiring one would be circular.
    requiresApproval: false,
    idempotent: true,
    description: 'Post an approval request for a human decision to an allowlisted Teams channel.',
  },
  {
    name: 'm365.document.store',
    version: 1,
    sideEffect: 'internal_write',
    // Sites.Selected grants access ONLY to sites an admin explicitly grants the
    // app, which is the SharePoint-side mirror of our own allowlist.
    requiredScopes: ['Sites.Selected'],
    resourceKinds: ['sharepoint_library'],
    requiresApproval: true,
    idempotent: true,
    description: 'Store one artifact in an allowlisted SharePoint development library.',
  },
] as const;

const BY_NAME = new Map<string, CapabilitySpec>(CAPABILITY_CATALOG.map((c) => [c.name, c]));

export const CAPABILITY_NAMES: readonly CapabilityName[] = CAPABILITY_CATALOG.map((c) => c.name);

/** Names that are explicitly refused, not merely unimplemented. */
export const FORBIDDEN_CAPABILITIES: readonly string[] = [
  'm365.mail.message.send',
  'm365.mail.message.reply',
  'm365.mail.message.forward',
  'm365.mail.message.delete',
  'm365.mail.message.move',
  'm365.calendar.event.create',
  'm365.document.delete',
  'm365.teams.meeting.create',
];

export function findCapability(name: string): CapabilitySpec | null {
  return BY_NAME.get(name) ?? null;
}

export function isForbiddenCapability(name: string): boolean {
  return FORBIDDEN_CAPABILITIES.includes(name);
}

/** Union of every scope the catalog can ask for — the ceiling for consent. */
export function catalogScopes(): readonly string[] {
  const all = new Set<string>();
  for (const c of CAPABILITY_CATALOG) for (const s of c.requiredScopes) all.add(s);
  return [...all].sort();
}

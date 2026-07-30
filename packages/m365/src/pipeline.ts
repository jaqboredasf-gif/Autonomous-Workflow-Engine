// ---------------------------------------------------------------------------
// pipeline.ts — the first proof slice, end to end.
//
// One Graph notification about one message in one allowlisted development
// mailbox, carried through the controlled execution path:
//
//   1  receive notification            (caller hands us the envelope)
//   2  validate subscription + event   notifications.ts
//   3  claim delivery (at-least-once)  notifications.ts delivery ledger
//   4  create/associate objective, work package, task, execution  execution.ts
//   5  m365.mail.message.read          executor -> mail adapter
//   6  m365.mail.attachment.read       executor -> mail adapter (per attachment)
//   7  normalize into a ContextItem    normalize.ts (-> email_messages row)
//   8  m365.teams.notification.create  executor -> teams adapter
//   9  m365.teams.approval.request     executor -> teams adapter (pending approval)
//  10  synthetic decision              policy.ts approval store (a human's stand-in)
//  11  m365.mail.draft.create          ONLY when approved. Draft, never send.
//  12  m365.document.store             optional, approved, allowlisted library only
//  13  evidence + persistence plan     evidence.ts / persistence.ts
//
// The pipeline is orchestration only. It holds no authority: every step 5-12 is
// a CapabilityRequest through the executor, which re-checks tenant, allowlist,
// scope, policy and approval on each one. Skipping the executor is not possible
// from here — the adapters are not in scope in this module.
// ---------------------------------------------------------------------------

import type {
  ActingPrincipal,
  CapabilityName,
  CapabilityRequest,
  CapabilityResult,
  ContextItem,
  M365Mode,
  PolicyDecisionRef,
  ProviderFidelity,
  TargetResource,
} from './contracts.ts';
import { findCapability } from './capabilities.ts';
import type { ResourceAllowlist } from './allowlist.ts';
import { findEntry } from './allowlist.ts';
import type { Clock, EvidenceWriter } from './evidence.ts';
import { hashValue } from './evidence.ts';
import type { MicrosoftCapabilityExecutor } from './executor.ts';
import type { DeliveryLedger, GraphChangeNotification, NotificationRejection } from './notifications.ts';
import { validateNotification } from './notifications.ts';
import type { MicrosoftSubscriptionManager } from './subscriptions.ts';
import type { ExecutionRecord, ExecutionStatus, ExecutionStore, ObjectiveRef } from './execution.ts';
import { deriveExecutionId, deriveObjectiveId, deriveTaskId } from './execution.ts';
import type { ApprovalStore, PolicyEngine } from './policy.ts';
import type { MailAttachment, MailMessage } from './adapters/mail.ts';
import { normalizeMessage, withStoredAttachment } from './normalize.ts';

export interface SliceDeps {
  readonly aweTenantId: string;
  readonly microsoftTenantId: string;
  readonly allowlist: ResourceAllowlist;
  readonly subscriptions: MicrosoftSubscriptionManager;
  readonly deliveries: DeliveryLedger;
  readonly executor: MicrosoftCapabilityExecutor;
  readonly executions: ExecutionStore;
  readonly evidence: EvidenceWriter;
  readonly policy: PolicyEngine;
  readonly approvals: ApprovalStore;
  readonly clock: Clock;
  readonly mode: M365Mode;
  readonly fidelity: ProviderFidelity;
  /** The app identity the reads and posts run as. */
  readonly servicePrincipal: ActingPrincipal;
  /** The human whose authority a draft is created under. */
  readonly approverPrincipal: ActingPrincipal;
  readonly approverRole: string;
  /** Teams channel to notify; must be allowlisted. */
  readonly teamsChannelId: string;
  /** SharePoint library for attachment storage; omit to skip step 12. */
  readonly sharepointLibraryId?: string | null;
  readonly options?: SliceOptions;
}

export interface SliceOptions {
  /**
   * The synthetic decision that stands in for a human. 'none' leaves the
   * approval pending, which is the missing-approval test: the draft capability
   * is still attempted and must be denied.
   */
  readonly syntheticDecision?: 'approved' | 'rejected' | 'none';
  readonly storeAttachments?: boolean;
  readonly workPackageId?: string;
  /** Draft content builder. Recipients must be @example.invalid in TEST mode. */
  readonly draft?: (item: ContextItem) => { subject: string; bodyText: string; toAddrs: readonly string[] };
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
}

export type SliceStatus = 'completed' | 'partially_completed' | 'failed' | 'rejected' | 'duplicate';

export interface SliceResult {
  readonly status: SliceStatus;
  readonly executionId: string | null;
  readonly objective: ObjectiveRef | null;
  readonly execution: ExecutionRecord | null;
  readonly contextItem: ContextItem | null;
  readonly notificationAudit: NotificationAudit;
  readonly results: readonly CapabilityResult[];
  readonly draftMessageId: string | null;
  readonly teamsMessageIds: readonly string[];
  readonly storedDocumentIds: readonly string[];
  readonly approvalId: string | null;
  readonly detail: string | null;
}

export interface NotificationAudit {
  readonly receivedAt: string;
  readonly subscriptionId: string;
  readonly aweTenantId: string;
  readonly microsoftTenantId: string;
  readonly resource: string;
  readonly changeType: string;
  readonly deliveryKey: string | null;
  readonly accepted: boolean;
  readonly rejection: NotificationRejection | null;
  readonly detail: string | null;
  readonly executionId: string | null;
  readonly deliveryCount: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export async function runInboundMailSlice(
  notification: GraphChangeNotification,
  deps: SliceDeps,
): Promise<SliceResult> {
  const opts = deps.options ?? {};
  const receivedAt = deps.clock.now();
  const workPackageId = opts.workPackageId ?? 'wp.inbound_mail_triage';
  const results: CapabilityResult[] = [];
  const teamsMessageIds: string[] = [];
  const storedDocumentIds: string[] = [];

  const baseAudit = {
    receivedAt,
    subscriptionId: notification?.subscriptionId ?? '',
    aweTenantId: deps.aweTenantId,
    microsoftTenantId: notification?.tenantId ?? '',
    resource: notification?.resource ?? '',
    changeType: notification?.changeType ?? '',
  };

  // --- 2. Validate ----------------------------------------------------------
  const verdict = validateNotification(notification, {
    allowlist: deps.allowlist,
    subscriptions: deps.subscriptions,
    aweTenantId: deps.aweTenantId,
    nowIso: receivedAt,
    requireDevelopmentResource: deps.mode === 'TEST',
  });

  if (!verdict.accepted) {
    // A refused notification never reaches a capability, so it produces no
    // capability evidence. It is still recorded — in the notification ledger
    // (m365_notifications), with its reason — so a refusal is provable.
    return {
      status: 'rejected',
      executionId: null,
      objective: null,
      execution: null,
      contextItem: null,
      notificationAudit: {
        ...baseAudit,
        deliveryKey: null,
        accepted: false,
        rejection: verdict.rejection,
        detail: verdict.detail,
        executionId: null,
        deliveryCount: 1,
      },
      results: [],
      draftMessageId: null,
      teamsMessageIds: [],
      storedDocumentIds: [],
      approvalId: null,
      detail: verdict.detail,
    };
  }

  // --- 3. Claim the delivery (at-least-once -> exactly-once work) -----------
  const executionId = deriveExecutionId(deps.aweTenantId, verdict.deliveryKey);
  const claim = deps.deliveries.claim(
    verdict.deliveryKey, deps.aweTenantId, verdict.subscriptionId, executionId, receivedAt,
  );

  if (!claim.first) {
    // Redelivery. Do nothing at all: no objective, no execution, no capability,
    // no draft. Return the original execution so the caller can correlate.
    const existing = deps.executions.get(claim.entry.executionId);
    return {
      status: 'duplicate',
      executionId: claim.entry.executionId,
      objective: null,
      execution: existing,
      contextItem: null,
      notificationAudit: {
        ...baseAudit,
        deliveryKey: verdict.deliveryKey,
        accepted: true,
        rejection: null,
        detail: `duplicate delivery #${claim.entry.deliveryCount}; first seen ${claim.entry.firstSeenAt}`,
        executionId: claim.entry.executionId,
        deliveryCount: claim.entry.deliveryCount,
      },
      results: [],
      draftMessageId: null,
      teamsMessageIds: [],
      storedDocumentIds: [],
      approvalId: null,
      detail: 'duplicate delivery',
    };
  }

  const notificationAudit: NotificationAudit = {
    ...baseAudit,
    deliveryKey: verdict.deliveryKey,
    accepted: true,
    rejection: null,
    detail: null,
    executionId,
    deliveryCount: 1,
  };

  const startedAt = deps.clock.now();
  const finishExecution = (
    status: ExecutionStatus,
    objectiveId: string,
    detail: string | null,
  ): ExecutionRecord => {
    const record: ExecutionRecord = {
      executionId,
      aweTenantId: deps.aweTenantId,
      microsoftTenantId: deps.microsoftTenantId,
      objectiveId,
      workPackageId,
      taskId: deriveTaskId(executionId, 'slice'),
      correlationId: executionId,
      deliveryKey: verdict.deliveryKey,
      subscriptionId: verdict.subscriptionId,
      status,
      startedAt,
      endedAt: status === 'running' ? null : deps.clock.now(),
      detail,
    };
    deps.executions.put(record);
    return record;
  };

  // Capability requests are built in one place so no step can quietly omit an
  // identity field or invent its own bounds.
  const request = (
    capability: CapabilityName,
    targetResource: TargetResource,
    objectiveId: string,
    principal: ActingPrincipal,
    input: Record<string, unknown>,
    approvalId: string | null,
  ): CapabilityRequest => {
    const spec = findCapability(capability)!;
    const idempotencyKey = `idem_${hashValue({ e: executionId, c: capability, r: targetResource.id }).slice(0, 40)}`;
    const policyDecision: PolicyDecisionRef = deps.policy.decide({
      aweTenantId: deps.aweTenantId,
      capability,
      targetResource,
      executionId,
      objectiveId,
      actingPrincipal: principal,
      atIso: deps.clock.now(),
    });
    const approval = approvalId ? deps.approvals.get(approvalId) : null;
    return {
      aweTenantId: deps.aweTenantId,
      microsoftTenantId: deps.microsoftTenantId,
      objectiveId,
      workPackageId,
      taskId: deriveTaskId(executionId, capability),
      executionId,
      capability,
      capabilityVersion: spec.version,
      actingPrincipal: principal,
      targetResource,
      requiredScopes: spec.requiredScopes,
      policyDecisionRef: policyDecision,
      approvalRef: approval,
      idempotencyKey,
      correlationId: executionId,
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      input,
    };
  };

  const run = async (req: CapabilityRequest): Promise<CapabilityResult> => {
    const result = await deps.executor.execute(req);
    results.push(result);
    return result;
  };

  // Provisional objective id: derived from the message, so the real ContextItem
  // (built two steps later) resolves to the same value.
  const provisionalObjectiveId = deriveObjectiveId(
    deps.aweTenantId,
    `ctx_${hashValue({ t: deps.aweTenantId, m: verdict.messageId }).slice(0, 32)}`,
  );

  const bail = (status: SliceStatus, detail: string, contextItem: ContextItem | null, approvalId: string | null): SliceResult => ({
    status,
    executionId,
    objective: deps.executions.objectiveForContextItem(deps.aweTenantId, contextItem?.contextItemId ?? '') ?? null,
    execution: finishExecution(status === 'partially_completed' ? 'partially_succeeded' : 'failed', provisionalObjectiveId, detail),
    contextItem,
    notificationAudit,
    results,
    draftMessageId: null,
    teamsMessageIds,
    storedDocumentIds,
    approvalId,
    detail,
  });

  // --- 5. Read the message (+ its attachment manifest) ----------------------
  const messageResource: TargetResource = { kind: 'message', id: verdict.messageId, parent: verdict.mailbox };
  const readResult = await run(request(
    'm365.mail.message.read', messageResource, provisionalObjectiveId, deps.servicePrincipal, {}, null,
  ));
  if (readResult.outcome !== 'succeeded') {
    return bail('failed', `message read ${readResult.outcome}: ${readResult.detail ?? ''}`, null, null);
  }
  const read = readResult.data as { message: MailMessage; attachments: readonly MailAttachment[] };

  // --- 6. Read attachment bytes --------------------------------------------
  const retrieved: MailAttachment[] = [];
  let attachmentFailure: string | null = null;
  for (const manifest of read.attachments) {
    const attachmentResult = await run(request(
      'm365.mail.attachment.read',
      { kind: 'attachment', id: manifest.id, parent: verdict.mailbox },
      provisionalObjectiveId,
      deps.servicePrincipal,
      { messageId: verdict.messageId },
      null,
    ));
    if (attachmentResult.outcome === 'succeeded') {
      retrieved.push(attachmentResult.data as MailAttachment);
    } else {
      // Partial failure is a first-class outcome: the message is still usable,
      // the attachment is recorded as not retrieved, and the execution says so.
      retrieved.push(manifest);
      attachmentFailure = `attachment '${manifest.id}' ${attachmentResult.outcome}: ${attachmentResult.detail ?? ''}`;
    }
  }

  // --- 7. Normalize into a ContextItem --------------------------------------
  let contextItem = normalizeMessage({
    aweTenantId: deps.aweTenantId,
    microsoftTenantId: deps.microsoftTenantId,
    message: read.message,
    attachments: retrieved,
    subscriptionId: verdict.subscriptionId,
    fidelity: deps.fidelity,
    // Synthetic content is always fixture content. This is what keeps fake data
    // out of the real corpus (0011: only fixture rows may lack a graph id).
    isFixture: deps.fidelity === 'synthetic',
  });

  // --- 4/8. Objective association ------------------------------------------
  const existingObjective = deps.executions.objectiveForContextItem(deps.aweTenantId, contextItem.contextItemId);
  const objective: ObjectiveRef = existingObjective ?? {
    objectiveId: deriveObjectiveId(deps.aweTenantId, contextItem.contextItemId),
    aweTenantId: deps.aweTenantId,
    originContextItemId: contextItem.contextItemId,
    createdAt: deps.clock.now(),
    reused: false,
  };
  if (!existingObjective) deps.executions.putObjective(objective);
  const objectiveId = objective.objectiveId;

  // --- 9. Teams notification about the accepted event -----------------------
  const channelResource: TargetResource = { kind: 'teams_channel', id: deps.teamsChannelId };
  const notifyResult = await run(request(
    'm365.teams.notification.create', channelResource, objectiveId, deps.servicePrincipal,
    {
      title: 'AWE: inbound request received (development)',
      bodyText: [
        `mailbox: ${contextItem.mailbox}`,
        `from: ${contextItem.fromAddr}`,
        `subject: ${contextItem.subject ?? '(none)'}`,
        `attachments: ${contextItem.attachments.length}`,
        `content hash: ${contextItem.contentHash.slice(0, 16)}`,
      ].join('\n'),
    },
    null,
  ));
  if (notifyResult.outcome === 'succeeded') {
    const id = notifyResult.microsoftResourceIds.teamsMessageId;
    if (id) teamsMessageIds.push(id);
  }

  // --- 10. Ask for approval of the draft ------------------------------------
  const mailboxResource: TargetResource = { kind: 'mailbox', id: contextItem.mailbox };
  const approval = deps.approvals.request({
    aweTenantId: deps.aweTenantId,
    capability: 'm365.mail.draft.create',
    targetResource: mailboxResource,
    executionId,
    objectiveId,
    approverRole: deps.approverRole,
    reason: `draft reply to ${contextItem.fromAddr}`,
    atIso: deps.clock.now(),
  });

  await run(request(
    'm365.teams.approval.request', channelResource, objectiveId, deps.servicePrincipal,
    {
      title: 'AWE: approval requested — create Outlook draft (development)',
      bodyText: `A draft reply is proposed for "${contextItem.subject ?? '(no subject)'}" from ${contextItem.fromAddr}.`,
      approvalId: approval.id,
      capability: 'm365.mail.draft.create',
      approverRole: deps.approverRole,
      resourceLabel: contextItem.mailbox,
    },
    null,
  ));
  const approvalPostId = results[results.length - 1]?.microsoftResourceIds.teamsMessageId;
  if (approvalPostId) teamsMessageIds.push(approvalPostId);

  // --- 11. The synthetic decision -------------------------------------------
  // Stands in for a human in the approval queue. It is synthetic, it is recorded
  // as such, and it can only ever unlock a draft in a development mailbox.
  const decision = opts.syntheticDecision ?? 'approved';
  if (decision !== 'none') {
    deps.approvals.decide(approval.id, decision, deps.approverPrincipal, deps.clock.now());
  }

  // --- 12. Create the Outlook DRAFT (never a send) --------------------------
  const draftContent = (opts.draft ?? defaultDraft)(contextItem);
  const draftResult = await run(request(
    'm365.mail.draft.create', mailboxResource, objectiveId, deps.approverPrincipal,
    {
      subject: draftContent.subject,
      bodyText: draftContent.bodyText,
      toAddrs: draftContent.toAddrs,
    },
    approval.id,
  ));
  const draftMessageId = draftResult.outcome === 'succeeded'
    ? draftResult.microsoftResourceIds.draftMessageId ?? null
    : null;

  // --- 13. Optionally store attachments in SharePoint -----------------------
  if (opts.storeAttachments && deps.sharepointLibraryId && draftResult.outcome === 'succeeded') {
    const library = findEntry(deps.allowlist, 'sharepoint_library', deps.sharepointLibraryId);
    if (library) {
      for (const attachment of retrieved.filter((a) => a.contentBase64 != null)) {
        const context = contextItem.attachments.find((a) => a.attachmentId === attachment.id);
        const storeApproval = deps.approvals.request({
          aweTenantId: deps.aweTenantId,
          capability: 'm365.document.store',
          targetResource: { kind: 'sharepoint_library', id: library.id },
          executionId,
          objectiveId,
          approverRole: deps.approverRole,
          reason: `store attachment '${attachment.name}'`,
          atIso: deps.clock.now(),
        });
        if (decision !== 'none') {
          deps.approvals.decide(storeApproval.id, decision, deps.approverPrincipal, deps.clock.now());
        }
        const storeResult = await run(request(
          'm365.document.store', { kind: 'sharepoint_library', id: library.id }, objectiveId, deps.approverPrincipal,
          {
            fileName: attachment.name,
            contentType: attachment.contentType,
            contentBase64: attachment.contentBase64,
            contentHash: context?.contentHash ?? '',
          },
          storeApproval.id,
        ));
        if (storeResult.outcome === 'succeeded') {
          const id = storeResult.microsoftResourceIds.driveItemId;
          if (id) {
            storedDocumentIds.push(id);
            contextItem = withStoredAttachment(contextItem, attachment.id, id);
          }
        }
      }
    }
  }

  // --- Outcome --------------------------------------------------------------
  const denied = results.filter((r) => r.outcome === 'denied');
  const failed = results.filter((r) => r.outcome === 'failed');
  const status: SliceStatus =
    denied.length === 0 && failed.length === 0 ? 'completed'
      : draftResult.outcome === 'succeeded' || readResult.outcome === 'succeeded' ? 'partially_completed'
        : 'failed';

  const detail = [
    attachmentFailure,
    denied.length > 0 ? `denied: ${denied.map((d) => `${d.capability}/${d.denialReason}`).join(', ')}` : null,
    failed.length > 0 ? `failed: ${failed.map((f) => `${f.capability}/${f.failureReason}`).join(', ')}` : null,
  ].filter((x): x is string => x != null).join('; ') || null;

  const execution = finishExecution(
    status === 'completed' ? 'succeeded' : status === 'failed' ? 'failed' : 'partially_succeeded',
    objectiveId,
    detail,
  );

  return {
    status,
    executionId,
    objective,
    execution,
    contextItem,
    notificationAudit,
    results,
    draftMessageId,
    teamsMessageIds,
    storedDocumentIds,
    approvalId: approval.id,
    detail,
  };
}

/**
 * Default draft body. Deliberately minimal and non-committal: v1 drafts are a
 * starting point a human edits (docs/testing/APPROVAL_MATRIX.md), and the
 * recipient is forced into the reserved .invalid domain in TEST mode by the
 * executor's TEST-mode gate — this function does not get to decide that.
 */
function defaultDraft(item: ContextItem): { subject: string; bodyText: string; toAddrs: readonly string[] } {
  return {
    subject: `Re: ${item.subject ?? 'your message'}`,
    bodyText: [
      'Hello,',
      '',
      'Thank you for your message. It is with our office for review and someone',
      'will get back to you directly.',
      '',
      `[AWE development draft — context ${item.contextItemId}]`,
    ].join('\n'),
    toAddrs: [item.fromAddr],
  };
}

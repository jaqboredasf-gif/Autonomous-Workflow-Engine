// Status machine + approval policy.
//
// Pure functions only — the UI asks what is allowed, it never decides on its own.
// This is the file to argue over with management: it encodes the workflow rules
// we are trying to confirm.

import type { DemoSettings, PurchaseRequest, RequestStatus } from './types';

/**
 * Which statuses can follow a given status. Terminal states have no exits:
 * a rejected or canceled request is re-raised as a new request, not revived.
 */
export const ALLOWED_TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  Draft: ['Pending Approval', 'Approved', 'Canceled'],
  'Pending Approval': ['Approved', 'Rejected', 'Canceled'],
  Approved: ['Ordered', 'Canceled'],
  Ordered: ['Received', 'Canceled'],
  Received: ['Completed'],
  Completed: [],
  Rejected: [],
  Canceled: [],
};

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: RequestStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

/**
 * Configurable approval behavior — not every request needs a sign-off.
 *
 * `never`     — submitting sends the request straight to Approved.
 * `always`    — every request waits for an approver.
 * `threshold` — only requests at or above the dollar threshold wait.
 *
 * Emergency priority can be forced to require approval regardless of cost,
 * because an emergency buy is exactly when someone should be told.
 */
export function requiresApproval(
  request: Pick<PurchaseRequest, 'estimatedCost' | 'priority'>,
  settings: DemoSettings,
): boolean {
  if (settings.alwaysApproveEmergency && request.priority === 'Emergency') return true;
  switch (settings.approvalMode) {
    case 'never':
      return false;
    case 'always':
      return true;
    case 'threshold':
      return request.estimatedCost >= settings.approvalThreshold;
  }
}

/** Human-readable explanation of the rule that applied, shown in the UI. */
export function explainApproval(
  request: Pick<PurchaseRequest, 'estimatedCost' | 'priority'>,
  settings: DemoSettings,
): string {
  if (settings.alwaysApproveEmergency && request.priority === 'Emergency') {
    return 'Emergency priority always requires approval.';
  }
  switch (settings.approvalMode) {
    case 'never':
      return 'Approval is turned off — requests are approved on submit.';
    case 'always':
      return 'All requests require approval.';
    case 'threshold':
      return request.estimatedCost >= settings.approvalThreshold
        ? `Estimated cost is at or above the $${settings.approvalThreshold.toLocaleString('en-US')} approval threshold.`
        : `Estimated cost is below the $${settings.approvalThreshold.toLocaleString('en-US')} approval threshold.`;
  }
}

/** The status a newly submitted request lands in. */
export function statusOnSubmit(
  request: Pick<PurchaseRequest, 'estimatedCost' | 'priority'>,
  settings: DemoSettings,
): RequestStatus {
  return requiresApproval(request, settings) ? 'Pending Approval' : 'Approved';
}

/** A PO can only be cut once the request has cleared approval. */
export function canGeneratePo(request: PurchaseRequest): boolean {
  return request.poNumber === null && ['Approved', 'Ordered'].includes(request.status);
}

export const STATUS_STYLES: Record<RequestStatus, string> = {
  Draft: 'bg-neutral-100 text-neutral-700 ring-neutral-300',
  'Pending Approval': 'bg-amber-100 text-amber-800 ring-amber-300',
  Approved: 'bg-blue-100 text-blue-800 ring-blue-300',
  Ordered: 'bg-indigo-100 text-indigo-800 ring-indigo-300',
  Received: 'bg-teal-100 text-teal-800 ring-teal-300',
  Completed: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
  Rejected: 'bg-red-100 text-red-800 ring-red-300',
  Canceled: 'bg-neutral-200 text-neutral-600 ring-neutral-400',
};

/** Happy-path order used by the detail-page timeline. */
export const TIMELINE_STEPS: RequestStatus[] = [
  'Draft',
  'Pending Approval',
  'Approved',
  'Ordered',
  'Received',
  'Completed',
];

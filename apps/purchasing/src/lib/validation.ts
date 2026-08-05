// Request validation — pure, UI-free, so the same rules can move server-side later.

import type { RequestDraft } from './types';

export interface ValidationResult {
  /** Keyed by form field: requestorId, jobId, vendorId, lines, estimatedCost. */
  fieldErrors: Record<string, string>;
  /** Keyed by material line id. */
  lineErrors: Record<string, string>;
  ok: boolean;
}

export function validateRequest(draft: RequestDraft): ValidationResult {
  const fieldErrors: Record<string, string> = {};
  const lineErrors: Record<string, string> = {};

  if (!draft.requestorId) fieldErrors.requestorId = 'Requestor is required.';

  // One job per request. The single-select control makes more than one
  // structurally impossible; this check catches a bad payload from anywhere else.
  if (!draft.jobId) fieldErrors.jobId = 'Job number is required.';

  // One vendor per request, same reasoning. Split the order if two are needed.
  if (!draft.vendorId) fieldErrors.vendorId = 'Vendor is required.';

  if (draft.lines.length === 0) {
    fieldErrors.lines = 'Add at least one material item.';
  }

  for (const line of draft.lines) {
    if (!line.description.trim()) {
      lineErrors[line.id] = 'Description is required.';
    } else if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      lineErrors[line.id] = 'Quantity must be greater than zero.';
    }
  }

  if (draft.estimatedCost.trim() !== '') {
    const parsed = Number(draft.estimatedCost);
    if (!Number.isFinite(parsed) || parsed < 0) {
      fieldErrors.estimatedCost = 'Estimated cost must be a number of zero or more.';
    }
  }

  return {
    fieldErrors,
    lineErrors,
    ok: Object.keys(fieldErrors).length === 0 && Object.keys(lineErrors).length === 0,
  };
}

export function parseEstimatedCost(raw: string): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

// Demo persistence layer.
//
// The ONLY place demo data is read or written. Today it is a single
// localStorage record; swapping it for a real API means reimplementing this
// module's exports and nothing else. There are no network calls here.

import { buildInitialState, STATE_VERSION } from './demo-data';
import { formatPoNumber, nextSequence } from './po';
import { statusOnSubmit } from './status';
import type {
  DemoSettings,
  DemoState,
  HistoryEvent,
  MaterialLine,
  PurchaseRequest,
  RequestStatus,
} from './types';

const STORAGE_KEY = 'lippolis.purchasing.demo.v1';

export function loadState(): DemoState {
  if (typeof window === 'undefined') return buildInitialState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return buildInitialState();
    const parsed = JSON.parse(raw) as DemoState;
    // Anything unexpected (older shape, hand-edited value) falls back to seed
    // data rather than throwing in front of an audience.
    if (!parsed || parsed.version !== STATE_VERSION || !Array.isArray(parsed.requests)) {
      return buildInitialState();
    }
    return parsed;
  } catch {
    return buildInitialState();
  }
}

export function saveState(state: DemoState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private-browsing quota errors must not break the demo; the session
    // simply stops persisting across reloads.
  }
}

export function resetState(): DemoState {
  const fresh = buildInitialState();
  saveState(fresh);
  return fresh;
}

let idCounter = 0;
function uid(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

export function newLine(): MaterialLine {
  return { id: uid('line'), quantity: 1, unit: 'ea', description: '', stockNumber: '' };
}

function event(actor: string, action: string, detail?: string): HistoryEvent {
  return { id: uid('h'), at: new Date().toISOString(), actor, action, detail };
}

/** Request IDs continue the PR-#### series already visible in the demo data. */
function nextRequestId(state: DemoState): string {
  const highest = state.requests.reduce((max, r) => {
    const n = Number(r.id.replace(/\D/g, ''));
    return Number.isFinite(n) && n > max ? n : max;
  }, 1000);
  return `PR-${highest + 1}`;
}

export interface NewRequestInput {
  requestorId: string;
  jobId: string;
  vendorId: string;
  priority: PurchaseRequest['priority'];
  neededBy: string;
  estimatedCost: number;
  notes: string;
  lines: MaterialLine[];
  /** Save as a draft instead of submitting it into the workflow. */
  asDraft: boolean;
  actor: string;
}

export function createRequest(
  state: DemoState,
  input: NewRequestInput,
): { state: DemoState; request: PurchaseRequest } {
  const now = new Date().toISOString();
  const status: RequestStatus = input.asDraft
    ? 'Draft'
    : statusOnSubmit({ estimatedCost: input.estimatedCost, priority: input.priority }, state.settings);

  const detail = input.asDraft
    ? 'Saved as draft'
    : status === 'Approved'
      ? 'Auto-approved by the current approval settings'
      : 'Submitted for approval';

  const request: PurchaseRequest = {
    id: nextRequestId(state),
    status,
    poNumber: null,
    requestorId: input.requestorId,
    jobId: input.jobId,
    vendorId: input.vendorId,
    priority: input.priority,
    neededBy: input.neededBy || null,
    estimatedCost: input.estimatedCost,
    notes: input.notes,
    lines: input.lines.map((l) => ({ ...l, stockNumber: l.stockNumber?.trim() || undefined })),
    createdAt: now,
    updatedAt: now,
    history: [event(input.actor, 'Created', detail)],
  };

  return { state: { ...state, requests: [request, ...state.requests] }, request };
}

function replaceRequest(state: DemoState, updated: PurchaseRequest): DemoState {
  return {
    ...state,
    requests: state.requests.map((r) => (r.id === updated.id ? updated : r)),
  };
}

export function transitionRequest(
  state: DemoState,
  id: string,
  to: RequestStatus,
  actor: string,
  action: string,
  detail?: string,
): DemoState {
  const request = state.requests.find((r) => r.id === id);
  if (!request) return state;
  const updated: PurchaseRequest = {
    ...request,
    status: to,
    updatedAt: new Date().toISOString(),
    history: [...request.history, event(actor, action, detail)],
  };
  return replaceRequest(state, updated);
}

export function addNote(state: DemoState, id: string, actor: string, note: string): DemoState {
  const request = state.requests.find((r) => r.id === id);
  if (!request || !note.trim()) return state;
  const updated: PurchaseRequest = {
    ...request,
    updatedAt: new Date().toISOString(),
    history: [...request.history, event(actor, 'Note added', note.trim())],
  };
  return replaceRequest(state, updated);
}

/**
 * Assigns the next sequential demo PO number. Numbers are handed out in order
 * and never reused; the counter lives in settings so it survives reloads.
 */
export function generatePo(
  state: DemoState,
  id: string,
  actor: string,
): { state: DemoState; poNumber: string | null } {
  const request = state.requests.find((r) => r.id === id);
  if (!request) return { state, poNumber: null };
  if (request.poNumber) return { state, poNumber: request.poNumber };

  const poNumber = formatPoNumber(state.settings.nextPoNumber);
  const updated: PurchaseRequest = {
    ...request,
    poNumber,
    updatedAt: new Date().toISOString(),
    history: [...request.history, event(actor, 'PO generated', poNumber)],
  };

  return {
    state: {
      ...replaceRequest(state, updated),
      settings: { ...state.settings, nextPoNumber: nextSequence(state.settings.nextPoNumber) },
    },
    poNumber,
  };
}

export function updateSettings(state: DemoState, settings: DemoSettings): DemoState {
  return { ...state, settings };
}

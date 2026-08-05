// Domain types for the purchasing-control demo.
//
// These mirror the shape a real backend would expose, so the localStorage
// store in `store.ts` can later be swapped for API calls without the UI
// changing. Nothing here touches the network or the Exattime Supabase schema.

export const REQUEST_STATUSES = [
  'Draft',
  'Pending Approval',
  'Approved',
  'Ordered',
  'Received',
  'Completed',
  'Rejected',
  'Canceled',
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const PRIORITIES = ['Emergency', 'High', 'Standard', 'Low'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Coarse geography used to suggest a supplier close to the job. */
export type Region = 'North' | 'Central' | 'South' | 'Statewide';

export interface Vendor {
  id: string;
  name: string;
  /** Regions this supplier reliably services / delivers to. */
  regions: Region[];
  /** Free-text hint shown in the picker: what they are good for. */
  specialty: string;
  contact: SupplierContact;
}

export interface SupplierContact {
  name: string;
  /** Demo address only — see README. No mail is ever sent to it. */
  email: string;
  phone: string;
  branch: string;
}

export interface Job {
  id: string;
  /** The job number the field uses. Required on every request. */
  number: string;
  name: string;
  address: string;
  region: Region;
}

export interface Requestor {
  id: string;
  name: string;
  role: 'Foreman' | 'Office' | 'Project Manager';
}

export interface MaterialLine {
  id: string;
  quantity: number;
  /** Unit of measure — free text ("ea", "ft", "box"). */
  unit: string;
  description: string;
  /** Optional supplier stock / part number. */
  stockNumber?: string;
}

export interface HistoryEvent {
  id: string;
  at: string;
  actor: string;
  /** Short label, e.g. "Approved" or "PO generated". */
  action: string;
  detail?: string;
}

export interface PurchaseRequest {
  id: string;
  status: RequestStatus;
  /** Assigned only when a PO is generated. Always `DEMO-` prefixed. */
  poNumber: string | null;
  requestorId: string;
  /** Exactly one job per request — enforced by the single-select UI and validation. */
  jobId: string;
  /** Exactly one vendor per request — same enforcement. */
  vendorId: string;
  priority: Priority;
  neededBy: string | null;
  /** Requestor's estimate in dollars. Not a quote. */
  estimatedCost: number;
  notes: string;
  lines: MaterialLine[];
  createdAt: string;
  updatedAt: string;
  history: HistoryEvent[];
}

export type ApprovalMode = 'never' | 'always' | 'threshold';

export interface DemoSettings {
  approvalMode: ApprovalMode;
  /** Used when approvalMode === 'threshold'. */
  approvalThreshold: number;
  /** Emergency-priority requests always route to an approver when true. */
  alwaysApproveEmergency: boolean;
  /** Next sequential PO number to hand out (see po.ts). */
  nextPoNumber: number;
}

/** The whole demo database, persisted as one localStorage record. */
export interface DemoState {
  version: number;
  settings: DemoSettings;
  vendors: Vendor[];
  jobs: Job[];
  requestors: Requestor[];
  requests: PurchaseRequest[];
}

/** Shape the new-request form produces before validation. */
export interface RequestDraft {
  requestorId: string;
  jobId: string;
  vendorId: string;
  priority: Priority;
  neededBy: string;
  estimatedCost: string;
  notes: string;
  lines: MaterialLine[];
}

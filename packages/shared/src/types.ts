// Shared domain types — used by mobile app, web admin, and the agent/MCP layer.

export type UserRole = 'admin' | 'foreman' | 'worker';
export type EntryStatus = 'open' | 'submitted' | 'approved' | 'locked';
export type GeoFlag = 'inside' | 'outside' | 'no_gps';
export type PayPeriodStatus = 'open' | 'closed' | 'exported';
export type ExportFormat = 'csv' | 'quickbooks' | 'adp';

export interface OrgSettings {
  orgId: string;
  timezone: string;
  roundingMinutes: number;
  otDailyHours: number;
  otWeeklyHours: number;
  /** Standard lunch window, local time. Current policy: 12:00–12:30, unpaid. */
  lunchStart: string; // "12:00"
  lunchEnd: string;   // "12:30"
  lunchPaid: boolean;
  lunchAutoDeduct: boolean;
  requirePunchPhoto: boolean;
}

export interface JobSite {
  id: string;
  orgId: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  radiusM: number;
  isActive: boolean;
}

export interface CostCode {
  id: string;
  orgId: string;
  code: string;
  label: string;
  isActive: boolean;
}

export interface TimeEntry {
  id: string;
  orgId: string;
  userId: string;
  jobSiteId: string | null;
  costCodeId: string | null;
  clockIn: string;  // ISO timestamp
  clockOut: string | null;
  inLat: number | null;
  inLng: number | null;
  inGeoFlag: GeoFlag;
  outLat: number | null;
  outLng: number | null;
  outGeoFlag: GeoFlag | null;
  inPhotoUrl: string | null;
  status: EntryStatus;
  deviceId: string | null;
  clientUuid: string | null;
  createdBy: string | null;
  notes: string | null;
}

/** A punch queued on-device while offline, synced later. */
export interface QueuedPunch {
  clientUuid: string;
  deviceId: string;
  kind: 'in' | 'out';
  userId: string;
  jobSiteId: string | null;
  costCodeId: string | null;
  at: string; // device timestamp, ISO
  lat: number | null;
  lng: number | null;
  photoLocalUri?: string;
}

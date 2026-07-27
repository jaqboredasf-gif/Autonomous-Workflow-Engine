// ---------------------------------------------------------------------------
// fixtures.mjs — the deterministic TEST-mode corpus.
//
// What TEST mode serves instead of live rows, and what the offline suite
// asserts against. Three properties, all deliberate:
//
//   obviously fake — every name is a placeholder and every id is prefixed
//                    `fixture:`, matching the repo's existing fixture-safety
//                    convention (G19). Nobody can mistake this for real data,
//                    and a guard that only allows `fixture:%` targets still
//                    holds.
//   multi-tenant   — TWO organisations, with overlapping employee names and
//                    overlapping job sites ON PURPOSE. A cross-tenant test that
//                    queries an empty second tenant proves nothing; these rows
//                    make "org A must not see Fiona Fixture of org B" a real
//                    assertion.
//   pinned in time — every instant is a literal. No clock, no relative dates,
//                    so the same query returns the same rows forever.
// ---------------------------------------------------------------------------

import { digest } from '../../awe-kernel/src/index.mjs';

// Fixture row ids are CONTENT-ADDRESSED, never built by interpolating the
// caller's text. An id like `fixture-lead-${summary}` is idempotent and looks
// harmless, but the id then travels into audit events (`entity_id`) and gate
// decisions, which is how a customer's name ends up in a control-plane record
// that was designed never to hold one. Runner M caught exactly that.
export function fixtureId(prefix, content) {
  return `fixture:${prefix}-${digest(content)}`;
}

export const FIXTURE_ORG_A = 'fixture:org-alpha';
export const FIXTURE_ORG_B = 'fixture:org-beta';

export const FIXTURE_ROWS = Object.freeze({
  users: [
    {
      id: 'fixture:user-a1', org_id: FIXTURE_ORG_A, full_name: 'Ada Fixture',
      role: 'field_employee', skills: ['troubleshooting', 'panel'], is_active: true, hourly_rate: 42,
    },
    {
      id: 'fixture:user-a2', org_id: FIXTURE_ORG_A, full_name: 'Ben Fixture',
      role: 'crew_leader', skills: ['panel'], is_active: true, hourly_rate: 55,
    },
    {
      id: 'fixture:user-a3', org_id: FIXTURE_ORG_A, full_name: 'Cleo Fixture',
      role: 'field_employee', skills: ['troubleshooting'], is_active: false, hourly_rate: 38,
    },
    // Same given-name prefix as Ada in org A: `create_shift`'s partial match on
    // "Ada" must still resolve to exactly one person WITHIN a tenant.
    {
      id: 'fixture:user-b1', org_id: FIXTURE_ORG_B, full_name: 'Ada Otherfirm',
      role: 'field_employee', skills: ['troubleshooting'], is_active: true, hourly_rate: 40,
    },
    // Two people in org A whose names both contain "Fix" — the ambiguity case.
    {
      id: 'fixture:user-b2', org_id: FIXTURE_ORG_B, full_name: 'Bo Otherfirm',
      role: 'crew_leader', skills: [], is_active: true, hourly_rate: 50,
    },
  ],

  job_sites: [
    {
      id: 'fixture:site-a1', org_id: FIXTURE_ORG_A, name: 'Alpha Depot',
      address: '1 Fixture Way', lat: 41.05, lng: -73.54, radius_m: 150, is_active: true,
    },
    {
      id: 'fixture:site-a2', org_id: FIXTURE_ORG_A, name: 'Alpha Annex',
      address: '2 Fixture Way', lat: 41.15, lng: -73.44, radius_m: 100, is_active: true,
    },
    {
      id: 'fixture:site-a3', org_id: FIXTURE_ORG_A, name: 'Alpha Retired Yard',
      address: '3 Fixture Way', lat: 41.25, lng: -73.34, radius_m: 100, is_active: false,
    },
    {
      id: 'fixture:site-b1', org_id: FIXTURE_ORG_B, name: 'Beta Depot',
      address: '9 Otherfirm Road', lat: 40.75, lng: -73.99, radius_m: 200, is_active: true,
    },
  ],

  time_entries: [
    {
      id: 'fixture:entry-a1', org_id: FIXTURE_ORG_A, user_id: 'fixture:user-a1',
      clock_in: '2026-07-20T11:00:00Z', clock_out: '2026-07-20T19:00:00Z',
      status: 'approved', in_geo_flag: 'inside', out_geo_flag: 'inside', notes: null,
      in_lat: 41.05, in_lng: -73.54,
      users: { full_name: 'Ada Fixture' }, job_sites: { name: 'Alpha Depot' },
      cost_codes: { code: '100', label: 'Service' },
    },
    {
      id: 'fixture:entry-a2', org_id: FIXTURE_ORG_A, user_id: 'fixture:user-a2',
      clock_in: '2026-07-21T11:30:00Z', clock_out: '2026-07-21T16:30:00Z',
      status: 'submitted', in_geo_flag: 'outside', out_geo_flag: 'inside', notes: 'geofence review',
      in_lat: 41.15, in_lng: -73.44,
      users: { full_name: 'Ben Fixture' }, job_sites: { name: 'Alpha Annex' },
      cost_codes: { code: '200', label: 'Install' },
    },
    {
      id: 'fixture:entry-a3', org_id: FIXTURE_ORG_A, user_id: 'fixture:user-a1',
      clock_in: '2026-07-22T10:00:00Z', clock_out: null,
      status: 'open', in_geo_flag: 'no_gps', out_geo_flag: null, notes: null,
      in_lat: null, in_lng: null,
      users: { full_name: 'Ada Fixture' }, job_sites: { name: 'Alpha Depot' },
      cost_codes: null,
    },
    {
      id: 'fixture:entry-b1', org_id: FIXTURE_ORG_B, user_id: 'fixture:user-b1',
      clock_in: '2026-07-20T12:00:00Z', clock_out: '2026-07-20T20:00:00Z',
      status: 'approved', in_geo_flag: 'outside', out_geo_flag: 'outside', notes: 'other tenant',
      in_lat: 40.75, in_lng: -73.99,
      users: { full_name: 'Ada Otherfirm' }, job_sites: { name: 'Beta Depot' },
      cost_codes: { code: '100', label: 'Service' },
    },
  ],

  shifts: [
    {
      id: 'fixture:shift-a1', org_id: FIXTURE_ORG_A, user_id: 'fixture:user-a1',
      starts_at: '2026-07-28T11:00:00Z', ends_at: '2026-07-28T19:00:00Z',
      status: 'scheduled', notes: null,
      users: { full_name: 'Ada Fixture' }, job_sites: { name: 'Alpha Depot' },
    },
    {
      id: 'fixture:shift-a2', org_id: FIXTURE_ORG_A, user_id: 'fixture:user-a2',
      starts_at: '2026-07-29T11:00:00Z', ends_at: '2026-07-29T19:00:00Z',
      status: 'cancelled', notes: 'called off',
      users: { full_name: 'Ben Fixture' }, job_sites: { name: 'Alpha Annex' },
    },
    {
      id: 'fixture:shift-b1', org_id: FIXTURE_ORG_B, user_id: 'fixture:user-b1',
      starts_at: '2026-07-28T11:00:00Z', ends_at: '2026-07-28T19:00:00Z',
      status: 'scheduled', notes: null,
      users: { full_name: 'Ada Otherfirm' }, job_sites: { name: 'Beta Depot' },
    },
  ],

  service_areas: [
    { org_id: FIXTURE_ORG_A, kind: 'county', value: 'Fairfield County', note: 'primary' },
    { org_id: FIXTURE_ORG_A, kind: 'zip', value: '06880', note: null },
    { org_id: FIXTURE_ORG_B, kind: 'county', value: 'Kings County', note: 'other tenant' },
  ],
});

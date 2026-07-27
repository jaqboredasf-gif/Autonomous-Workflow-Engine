// ---------------------------------------------------------------------------
// data-port.mjs — the neutral data-access boundary for MCP tool execution.
//
// Before this module, every MCP tool held a `db` client from module scope and
// wrote its own PostgREST query inline. Three consequences, all bad:
//
//   * no tool could be tested without a live Supabase project and a service-role
//     key, so none of them ever were;
//   * tenant scoping was per-query and mostly absent — the service role bypasses
//     RLS, so an unfiltered `select` returns EVERY tenant's rows;
//   * `log_lead` resolved its tenant with `from('orgs').select('id').limit(1)`,
//     i.e. "whichever org comes first", which is a single-tenant assumption
//     wearing a query's clothes (ADR-0002, condition 1).
//
// A DataPort is a small set of named, org-scoped reads and writes. Two
// implementations ship here: the Supabase one used in LIVE, and a deterministic
// fixture one used in TEST and by the offline suite. Neither is chosen by this
// module — the runtime is handed one.
//
// The invariant this file exists to enforce: **every method takes `org_id` and
// refuses without it.** Not "defaults to", not "falls back to" — refuses. A
// tenant is never inferred, never discovered, never remembered from a previous
// call. The choice of client (PostgREST today, a least-privilege Postgres role
// later) is ADR-0002 and stays open; the shape of the boundary does not.
//
// What is NOT here: authorization. The port scopes queries to the tenant it was
// TOLD to use. Deciding whether a caller may name that tenant is a Tool Registry
// question and is blocked on ADR-0002.
// ---------------------------------------------------------------------------

import { KernelError, invariant } from '../../awe-kernel/src/index.mjs';
import { fixtureId } from './fixtures.mjs';

export const DATA_PORT_METHODS = [
  'listTimeEntries', 'listOpenTimeEntries', 'listRecentPunches',
  'listJobSites', 'listEmployees', 'listShifts', 'findShiftConflicts',
  'createShift', 'listServiceAreas', 'createLead',
];

// Columns the tools read. Kept here, once, so a schema change is one edit and
// so no tool can widen its own selection to something it should not see.
const ENTRY_SELECT =
  'id, org_id, clock_in, clock_out, status, in_geo_flag, out_geo_flag, notes, '
  + 'users!time_entries_user_id_fkey(full_name), job_sites(name), cost_codes(code, label)';

const SHIFT_SELECT =
  'id, org_id, starts_at, ends_at, status, notes, '
  + 'users!shifts_user_id_fkey(full_name), job_sites(name)';

// The single chokepoint. Every method routes through it, so there is exactly one
// line to read to know that a tenant can never be omitted.
function requireOrg(org_id, method) {
  invariant(
    typeof org_id === 'string' && org_id.length > 0,
    'invalid_input', `${method} requires an explicit org_id — this platform never infers a tenant`,
    { method },
  );
  return org_id;
}

export function assertDataPort(port, where = {}) {
  invariant(
    port !== null && typeof port === 'object',
    'invalid_input', 'data port must be an object', { ...where },
  );
  for (const method of DATA_PORT_METHODS) {
    invariant(
      typeof port[method] === 'function',
      'invalid_input', `data port '${port.name}' must implement ${method}()`, { ...where, method },
    );
  }
  return port;
}

// --- Supabase implementation (LIVE) -----------------------------------------
//
// Every query filters `org_id` and every insert sets it. That is not belt and
// braces: the service role bypasses RLS entirely (ADR-0002), so these filters
// ARE the tenant boundary for this surface. Removing one is a cross-tenant data
// leak, not a missing optimisation.

export function createSupabaseDataPort(client, { name = 'supabase' } = {}) {
  invariant(
    client !== null && typeof client?.from === 'function',
    'invalid_input', 'createSupabaseDataPort needs a supabase-js client', {},
  );

  // PostgREST reports failures as a value, not a throw. Turning that into a
  // typed kernel error here means every tool body gets one failure shape and no
  // tool has to remember to check `error` — the pattern the old server got
  // wrong in `list_job_sites` and `list_employees`, which ignored `error` on the
  // count path entirely.
  const unwrap = ({ data, error }, method) => {
    if (error) {
      // The provider's message can carry a connection string or a token; the
      // code and the constraint name are what a caller can act on.
      throw new KernelError('sink_failure', `${method} failed: ${error.code ?? 'unknown'}`, {
        method, code: error.code ?? null,
      });
    }
    return data ?? [];
  };

  return Object.freeze({
    name,
    live: true,

    async listTimeEntries({ org_id, from, to }) {
      const q = await client.from('time_entries').select(ENTRY_SELECT)
        .eq('org_id', requireOrg(org_id, 'listTimeEntries'))
        .gte('clock_in', `${from}T00:00:00Z`)
        .lte('clock_in', `${to}T23:59:59Z`)
        .order('clock_in', { ascending: false });
      return unwrap(q, 'listTimeEntries');
    },

    async listOpenTimeEntries({ org_id, since }) {
      const q = await client.from('time_entries').select(ENTRY_SELECT)
        .eq('org_id', requireOrg(org_id, 'listOpenTimeEntries'))
        .gte('clock_in', since)
        .order('clock_in', { ascending: false });
      return unwrap(q, 'listOpenTimeEntries');
    },

    async listRecentPunches({ org_id, since }) {
      const q = await client.from('time_entries').select('user_id, in_lat, in_lng, clock_in')
        .eq('org_id', requireOrg(org_id, 'listRecentPunches'))
        .not('in_lat', 'is', null)
        .gte('clock_in', since)
        .order('clock_in', { ascending: false });
      return unwrap(q, 'listRecentPunches');
    },

    async listJobSites({ org_id, include_inactive = false }) {
      let q = client.from('job_sites').select('id, org_id, name, address, lat, lng, radius_m, is_active')
        .eq('org_id', requireOrg(org_id, 'listJobSites'));
      if (!include_inactive) q = q.eq('is_active', true);
      return unwrap(await q.order('name'), 'listJobSites');
    },

    async listEmployees({ org_id, include_inactive = false }) {
      let q = client.from('users').select('id, org_id, full_name, role, skills, is_active, hourly_rate')
        .eq('org_id', requireOrg(org_id, 'listEmployees'));
      if (!include_inactive) q = q.eq('is_active', true);
      return unwrap(await q.order('full_name'), 'listEmployees');
    },

    async listShifts({ org_id, from, to, include_cancelled = false }) {
      let q = client.from('shifts').select(SHIFT_SELECT)
        .eq('org_id', requireOrg(org_id, 'listShifts'))
        .gte('starts_at', `${from}T00:00:00Z`)
        .lte('starts_at', `${to}T23:59:59Z`);
      if (!include_cancelled) q = q.neq('status', 'cancelled');
      return unwrap(await q.order('starts_at'), 'listShifts');
    },

    async findShiftConflicts({ org_id, starts_at, ends_at }) {
      const q = await client.from('shifts').select('user_id, starts_at, ends_at')
        .eq('org_id', requireOrg(org_id, 'findShiftConflicts'))
        .neq('status', 'cancelled')
        .lt('starts_at', ends_at)
        .gt('ends_at', starts_at);
      return unwrap(q, 'findShiftConflicts');
    },

    async createShift({ org_id, user_id, job_site_id, starts_at, ends_at, notes }) {
      const q = await client.from('shifts')
        .insert({
          org_id: requireOrg(org_id, 'createShift'),
          user_id, job_site_id, starts_at, ends_at, notes: notes ?? null,
        })
        .select('id, org_id, starts_at, ends_at')
        .single();
      const row = q.error ? unwrap(q, 'createShift') : q.data;
      // The write-back check: a row that came back bound to a different tenant
      // than the one we asked for means the filter did not hold, and that is a
      // hard stop rather than a logged warning (G1).
      invariant(
        row?.org_id === org_id,
        'contract_violation', 'createShift returned a row bound to a different tenant',
        { expected: org_id, actual: row?.org_id ?? null },
      );
      return row;
    },

    async listServiceAreas({ org_id }) {
      const q = await client.from('service_areas').select('kind, value, note')
        .eq('org_id', requireOrg(org_id, 'listServiceAreas'));
      return unwrap(q, 'listServiceAreas');
    },

    async createLead({ org_id, ...fields }) {
      const q = await client.from('leads')
        .insert({ org_id: requireOrg(org_id, 'createLead'), ...fields })
        .select('id, org_id, received_at, priority, disposition')
        .single();
      const row = q.error ? unwrap(q, 'createLead') : q.data;
      invariant(
        row?.org_id === org_id,
        'contract_violation', 'createLead returned a row bound to a different tenant',
        { expected: org_id, actual: row?.org_id ?? null },
      );
      return row;
    },
  });
}

// --- Fixture implementation (TEST, and the offline suite) --------------------
//
// Deterministic and in-process: no clock, no network, no credential. It holds
// rows for MORE THAN ONE tenant on purpose, so that a test asserting "org A
// cannot see org B's rows" is asserting something real rather than querying an
// empty table and passing.

export function createFixtureDataPort({ rows = {}, name = 'fixture' } = {}) {
  const table = (key) => rows[key] ?? [];
  const scoped = (key, org_id, method) => table(key).filter((r) => r.org_id === requireOrg(org_id, method));

  return Object.freeze({
    name,
    live: false,

    async listTimeEntries({ org_id, from, to }) {
      return scoped('time_entries', org_id, 'listTimeEntries')
        .filter((r) => r.clock_in >= `${from}T00:00:00Z` && r.clock_in <= `${to}T23:59:59Z`)
        .sort((a, b) => (a.clock_in < b.clock_in ? 1 : -1));
    },
    async listOpenTimeEntries({ org_id, since }) {
      return scoped('time_entries', org_id, 'listOpenTimeEntries')
        .filter((r) => r.clock_in >= since)
        .sort((a, b) => (a.clock_in < b.clock_in ? 1 : -1));
    },
    async listRecentPunches({ org_id, since }) {
      return scoped('time_entries', org_id, 'listRecentPunches')
        .filter((r) => r.in_lat !== null && r.in_lat !== undefined && r.clock_in >= since)
        .map((r) => ({ user_id: r.user_id, in_lat: r.in_lat, in_lng: r.in_lng, clock_in: r.clock_in }))
        .sort((a, b) => (a.clock_in < b.clock_in ? 1 : -1));
    },
    async listJobSites({ org_id, include_inactive = false }) {
      return scoped('job_sites', org_id, 'listJobSites')
        .filter((r) => include_inactive || r.is_active)
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    },
    async listEmployees({ org_id, include_inactive = false }) {
      return scoped('users', org_id, 'listEmployees')
        .filter((r) => include_inactive || r.is_active)
        .sort((a, b) => (a.full_name < b.full_name ? -1 : 1));
    },
    async listShifts({ org_id, from, to, include_cancelled = false }) {
      return scoped('shifts', org_id, 'listShifts')
        .filter((r) => r.starts_at >= `${from}T00:00:00Z` && r.starts_at <= `${to}T23:59:59Z`)
        .filter((r) => include_cancelled || r.status !== 'cancelled')
        .sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));
    },
    async findShiftConflicts({ org_id, starts_at, ends_at }) {
      return scoped('shifts', org_id, 'findShiftConflicts')
        .filter((r) => r.status !== 'cancelled' && r.starts_at < ends_at && r.ends_at > starts_at)
        .map((r) => ({ user_id: r.user_id, starts_at: r.starts_at, ends_at: r.ends_at }));
    },
    async createShift({ org_id, user_id, job_site_id, starts_at, ends_at, notes }) {
      requireOrg(org_id, 'createShift');
      // Content-ADDRESSED, not content-BEARING: the id is a digest, so a fixture
      // write stays idempotent without the caller's text riding into the id and
      // from there into every audit event that names the row.
      return {
        id: fixtureId('shift', { org_id, user_id, starts_at, ends_at }),
        org_id, user_id, job_site_id, starts_at, ends_at, notes: notes ?? null,
      };
    },
    async listServiceAreas({ org_id }) {
      return scoped('service_areas', org_id, 'listServiceAreas');
    },
    async createLead({ org_id, ...fields }) {
      requireOrg(org_id, 'createLead');
      return {
        id: fixtureId('lead', { org_id, ...fields }),
        org_id,
        received_at: fields.received_at ?? null,
        priority: fields.priority ?? 'routine',
        disposition: fields.disposition ?? 'pending',
      };
    },
  });
}

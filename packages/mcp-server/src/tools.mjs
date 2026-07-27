// ---------------------------------------------------------------------------
// tools.mjs — the ten Exattime tools as descriptors plus kernel-outcome bodies.
//
// Each tool is now two separable things:
//
//   a DESCRIPTOR — transport-independent identity, schema references, side-
//     effect classification, lifecycle (packages/awe-kernel/src/tools.mjs);
//   a BODY       — `(input, { context, port, now }) -> outcome envelope`. It
//     contains business logic and nothing else: no validation boilerplate, no
//     tenant resolution, no result formatting, no error handling, no audit
//     emission, no persistence. Those belong to the run scaffolding, which is
//     the point of having one.
//
// A body may not throw, but it does not have to be careful about it: a throw
// becomes `failed(<code>)` in `runWorkflow`. What it must do is return an
// outcome envelope with a machine-readable code on every path, and never a
// human-readable string a caller would have to parse.
//
// Every read is scoped by `context.org_id`, which the runtime resolved
// explicitly. No body queries for a tenant, and none can: the port refuses a
// call without an `org_id`.
//
// The zod input schemas stay next to the descriptors because the MCP SDK wants
// them; the descriptor references them by NAME rather than embedding them, so
// the same tool can be exposed through a surface that validates differently.
// ---------------------------------------------------------------------------

import { z } from 'zod';

import { blocked, createEvent, defineTool, failed, succeeded } from '../../awe-kernel/src/index.mjs';

// --- shared helpers ----------------------------------------------------------

// Audit events carry WHAT a tool did, for whom, and how much came back — never
// the rows themselves. Timesheet rows carry names, GPS coordinates and notes;
// an audit trail is a control-plane record, not a second copy of the data
// (G17). The row count is what an operator reviewing an agent's activity
// actually needs.
function toolEvent(context, { tool, entity_type, entity_id = null, payload = {} }) {
  return createEvent({
    event_type: `agent.tool_${tool}`,
    entity_type,
    entity_id,
    org_id: context.org_id,
    occurred_at: context.started_at,
    payload: { tool, mode: context.mode, is_fixture: context.is_fixture, ...payload },
  });
}

const hoursBetween = (start, end) => +(((Date.parse(end) - Date.parse(start)) / 3.6e6).toFixed(2));

// A name lookup that matched anything other than exactly one record is a
// refusal, not a guess. The old server got this right for employees and sites
// and it is preserved: an ambiguous dispatch is worse than no dispatch.
function exactlyOne(matches, { what, term }) {
  if (matches.length === 1) return { ok: true, row: matches[0] };
  return {
    ok: false,
    detail: `${what} "${term}" matched ${matches.length} record(s); name a single ${what}`,
  };
}

const contains = (haystack, needle) =>
  typeof haystack === 'string' && haystack.toLowerCase().includes(needle.toLowerCase());

// `org_id` is an explicit, optional argument on EVERY tool. Optional because a
// single-tenant operator sets AWE_ORG_ID once at launch; explicit because a
// multi-tenant caller must be able to say which tenant it means, and because
// there is no other way to say it — nothing infers one.
const ORG_ARG = {
  org_id: z.string().optional().describe(
    'Tenant to act for. Required unless the server was launched with AWE_ORG_ID. Never inferred.',
  ),
};

// --- 1. get_timesheets -------------------------------------------------------

export const getTimesheets = {
  descriptor: defineTool({
    name: 'get_timesheets',
    workflow_id: 'mcp_get_timesheets',
    description:
      'List time entries between two dates, optionally filtered by employee name. '
      + 'Returns clock in/out times, hours, job site, cost code, GPS flags, and status.',
    input_schema: 'exattime.get_timesheets.input/v1',
    output_schema: 'exattime.time_entry_list/v1',
    side_effect: 'read',
    requires_tenant: true,
  }),
  inputSchema: {
    ...ORG_ARG,
    from: z.string().describe('Start date, YYYY-MM-DD'),
    to: z.string().describe('End date, YYYY-MM-DD'),
    employee: z.string().optional().describe('Filter by employee full name (partial match)'),
  },
  async body({ from, to, employee }, { context, port }) {
    const rows = await port.listTimeEntries({ org_id: context.org_id, from, to });
    const filtered = employee ? rows.filter((r) => contains(r.users?.full_name, employee)) : rows;
    const entries = filtered.map((r) => ({
      ...r,
      hours: r.clock_out ? hoursBetween(r.clock_in, r.clock_out) : null,
    }));
    return succeeded({ entries, count: entries.length }, {
      audit: [{ step: 'scope_tenant', ok: true, detail: context.org_id }],
      events: [toolEvent(context, {
        tool: 'get_timesheets', entity_type: 'time_entry',
        payload: { row_count: entries.length, filtered_by_employee: Boolean(employee), from, to },
      })],
    });
  },
};

// --- 2. get_flags ------------------------------------------------------------

export const getFlags = {
  descriptor: defineTool({
    name: 'get_flags',
    workflow_id: 'mcp_get_flags',
    description:
      'List anomalies needing human review: punches outside the job-site geofence, '
      + 'punches with no GPS, and entries left open (missing clock-out) for over 16 hours.',
    input_schema: 'exattime.get_flags.input/v1',
    output_schema: 'exattime.flag_list/v1',
    side_effect: 'read',
    requires_tenant: true,
  }),
  inputSchema: {
    ...ORG_ARG,
    days: z.number().int().min(1).max(90).default(14).describe('Look-back window in days'),
  },
  async body({ days }, { context, port, now }) {
    // `now` is supplied by the runtime, not read here. A tool that reads the
    // clock cannot be replayed, and this one is asked "the last 14 days" — the
    // answer has to be pinned to an instant somebody recorded.
    const since = new Date(Date.parse(now) - days * 864e5).toISOString();
    const rows = await port.listOpenTimeEntries({ org_id: context.org_id, since });

    const flags = [];
    for (const r of rows) {
      const who = r.users?.full_name ?? '?';
      const site = r.job_sites?.name ?? 'no site';
      if (r.in_geo_flag === 'outside') flags.push({ kind: 'outside_fence_in', who, site, entry: r });
      if (r.out_geo_flag === 'outside') flags.push({ kind: 'outside_fence_out', who, site, entry: r });
      if (r.in_geo_flag === 'no_gps') flags.push({ kind: 'no_gps', who, site, entry: r });
      if (!r.clock_out && Date.parse(now) - Date.parse(r.clock_in) > 16 * 3.6e6) {
        flags.push({ kind: 'missing_clock_out', who, site, entry: r });
      }
    }

    const byKind = {};
    for (const f of flags) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;

    return succeeded({ flags, count: flags.length, by_kind: byKind, window_days: days, since }, {
      audit: [
        { step: 'scope_tenant', ok: true, detail: context.org_id },
        { step: 'evaluate_flags', ok: true, detail: `${flags.length} flag(s) over ${days}d` },
      ],
      events: [toolEvent(context, {
        tool: 'get_flags', entity_type: 'time_entry',
        payload: { flag_count: flags.length, by_kind: byKind, window_days: days },
      })],
    });
  },
};

// --- 3. get_hours_report -----------------------------------------------------

export const getHoursReport = {
  descriptor: defineTool({
    name: 'get_hours_report',
    workflow_id: 'mcp_get_hours_report',
    description:
      'Aggregate completed hours between two dates, grouped by employee, job site, or cost code. '
      + 'Raw hours only — lunch deduction, overtime, and rounding are applied at payroll export.',
    input_schema: 'exattime.get_hours_report.input/v1',
    output_schema: 'exattime.hours_report/v1',
    side_effect: 'read',
    requires_tenant: true,
  }),
  inputSchema: {
    ...ORG_ARG,
    from: z.string().describe('Start date, YYYY-MM-DD'),
    to: z.string().describe('End date, YYYY-MM-DD'),
    group_by: z.enum(['employee', 'site', 'cost_code']).default('employee'),
  },
  async body({ from, to, group_by }, { context, port }) {
    const rows = (await port.listTimeEntries({ org_id: context.org_id, from, to }))
      .filter((r) => r.clock_out);

    const keyOf = (r) => (
      group_by === 'employee' ? r.users?.full_name ?? '?'
        : group_by === 'site' ? r.job_sites?.name ?? 'no site'
          : r.cost_codes ? `${r.cost_codes.code} — ${r.cost_codes.label}` : 'no code'
    );

    const totals = new Map();
    for (const r of rows) {
      const k = keyOf(r);
      const cur = totals.get(k) ?? { entries: 0, hours: 0 };
      cur.entries += 1;
      cur.hours += hoursBetween(r.clock_in, r.clock_out);
      totals.set(k, cur);
    }

    const report = [...totals.entries()]
      .map(([k, v]) => ({ [group_by]: k, entries: v.entries, hours: +v.hours.toFixed(2) }))
      // Ties broken by key so the same data always produces the same report.
      .sort((a, b) => b.hours - a.hours || (String(a[group_by]) < String(b[group_by]) ? -1 : 1));

    return succeeded({ report, group_by, from, to }, {
      audit: [{ step: 'scope_tenant', ok: true, detail: context.org_id }],
      events: [toolEvent(context, {
        tool: 'get_hours_report', entity_type: 'time_entry',
        payload: { group_by, group_count: report.length, entry_count: rows.length },
      })],
    });
  },
};

// --- 4. list_job_sites -------------------------------------------------------

export const listJobSites = {
  descriptor: defineTool({
    name: 'list_job_sites',
    workflow_id: 'mcp_list_job_sites',
    description: 'List job sites with geofence coordinates and radius.',
    input_schema: 'exattime.list_job_sites.input/v1',
    output_schema: 'exattime.job_site_list/v1',
    side_effect: 'read',
    requires_tenant: true,
  }),
  inputSchema: { ...ORG_ARG, include_inactive: z.boolean().default(false) },
  async body({ include_inactive }, { context, port }) {
    const sites = await port.listJobSites({ org_id: context.org_id, include_inactive });
    return succeeded({ job_sites: sites, count: sites.length }, {
      audit: [{ step: 'scope_tenant', ok: true, detail: context.org_id }],
      events: [toolEvent(context, {
        tool: 'list_job_sites', entity_type: 'job_site',
        payload: { row_count: sites.length, include_inactive },
      })],
    });
  },
};

// --- 5. list_employees -------------------------------------------------------

export const listEmployees = {
  descriptor: defineTool({
    name: 'list_employees',
    workflow_id: 'mcp_list_employees',
    description: 'List employees with role and active status.',
    input_schema: 'exattime.list_employees.input/v1',
    output_schema: 'exattime.employee_list/v1',
    side_effect: 'read',
    requires_tenant: true,
  }),
  inputSchema: { ...ORG_ARG, include_inactive: z.boolean().default(false) },
  async body({ include_inactive }, { context, port }) {
    const employees = await port.listEmployees({ org_id: context.org_id, include_inactive });
    return succeeded({ employees, count: employees.length }, {
      audit: [{ step: 'scope_tenant', ok: true, detail: context.org_id }],
      events: [toolEvent(context, {
        tool: 'list_employees', entity_type: 'user',
        payload: { row_count: employees.length, include_inactive },
      })],
    });
  },
};

// --- 6. get_schedule ---------------------------------------------------------

export const getSchedule = {
  descriptor: defineTool({
    name: 'get_schedule',
    workflow_id: 'mcp_get_schedule',
    description:
      'List scheduled shifts between two dates: who works when and at which job site. '
      + 'This is the schedule the M365 calendar sync mirrors.',
    input_schema: 'exattime.get_schedule.input/v1',
    output_schema: 'exattime.shift_list/v1',
    side_effect: 'read',
    requires_tenant: true,
  }),
  inputSchema: {
    ...ORG_ARG,
    from: z.string().describe('Start date, YYYY-MM-DD'),
    to: z.string().describe('End date, YYYY-MM-DD'),
    include_cancelled: z.boolean().default(false),
  },
  async body({ from, to, include_cancelled }, { context, port }) {
    const shifts = await port.listShifts({ org_id: context.org_id, from, to, include_cancelled });
    return succeeded({ shifts, count: shifts.length }, {
      audit: [{ step: 'scope_tenant', ok: true, detail: context.org_id }],
      events: [toolEvent(context, {
        tool: 'get_schedule', entity_type: 'shift',
        payload: { row_count: shifts.length, from, to, include_cancelled },
      })],
    });
  },
};

// --- 7. create_shift ---------------------------------------------------------

export const createShift = {
  descriptor: defineTool({
    name: 'create_shift',
    workflow_id: 'mcp_create_shift',
    description:
      'Schedule a shift for an employee. Names are matched case-insensitively against '
      + 'employees and job sites; the tool refuses if a name is ambiguous or unknown.',
    input_schema: 'exattime.create_shift.input/v1',
    output_schema: 'exattime.shift/v1',
    // The only write on this surface, and it is internal: it creates a row, it
    // sends nothing to anybody. Classification only — see kernel tools.mjs on
    // why this is not a permission.
    side_effect: 'write_internal',
    requires_tenant: true,
  }),
  inputSchema: {
    ...ORG_ARG,
    employee: z.string().describe('Employee full name'),
    job_site: z.string().optional().describe('Job site name'),
    starts_at: z.string().describe('Shift start, ISO 8601 (e.g. 2026-07-20T07:00:00-04:00)'),
    ends_at: z.string().describe('Shift end, ISO 8601'),
    notes: z.string().optional(),
  },
  async body({ employee, job_site, starts_at, ends_at, notes }, { context, port }) {
    const audit = [{ step: 'scope_tenant', ok: true, detail: context.org_id }];

    // Both lookups are tenant-scoped, so a name that exists in another business
    // is simply not found here. That is the binding doing its job.
    const people = (await port.listEmployees({ org_id: context.org_id }))
      .filter((u) => contains(u.full_name, employee));
    const person = exactlyOne(people, { what: 'employee', term: employee });
    audit.push({ step: 'resolve_employee', ok: person.ok, detail: person.ok ? person.row.full_name : person.detail });
    if (!person.ok) {
      return blocked('ambiguous_match', {
        audit,
        events: [toolEvent(context, {
          tool: 'create_shift', entity_type: 'shift',
          payload: { refused: 'employee', match_count: people.length },
        })],
        meta: { detail: person.detail },
      });
    }

    let siteId = null;
    if (job_site) {
      const sites = (await port.listJobSites({ org_id: context.org_id }))
        .filter((s) => contains(s.name, job_site));
      const site = exactlyOne(sites, { what: 'job site', term: job_site });
      audit.push({ step: 'resolve_job_site', ok: site.ok, detail: site.ok ? site.row.name : site.detail });
      if (!site.ok) {
        return blocked('ambiguous_match', {
          audit,
          events: [toolEvent(context, {
            tool: 'create_shift', entity_type: 'shift',
            payload: { refused: 'job_site', match_count: sites.length },
          })],
          meta: { detail: site.detail },
        });
      }
      siteId = site.row.id;
    }

    if (Date.parse(ends_at) <= Date.parse(starts_at)) {
      return failed('invalid_input', 'ends_at must be after starts_at', {
        audit: [...audit, { step: 'validate_window', ok: false, detail: 'ends_at <= starts_at' }],
      });
    }

    const created = await port.createShift({
      org_id: context.org_id,
      user_id: person.row.id,
      job_site_id: siteId,
      starts_at,
      ends_at,
      notes,
    });
    audit.push({ step: 'write_shift', ok: true, detail: created.id });

    // Post-write tenant assertion, in the tool as well as in the port. The
    // service role bypasses RLS, so this is the only layer that can catch a
    // write that landed against the wrong tenant (G1).
    if (created.org_id !== context.org_id) {
      return failed('contract_violation', 'created shift is bound to a different tenant', {
        audit: [...audit, { step: 'verify_tenant', ok: false, detail: 'org_id mismatch on the written row' }],
      });
    }
    audit.push({ step: 'verify_tenant', ok: true, detail: created.org_id });

    return succeeded({ created, employee: person.row.full_name }, {
      audit,
      events: [toolEvent(context, {
        tool: 'create_shift', entity_type: 'shift', entity_id: String(created.id),
        payload: { has_job_site: siteId !== null, starts_at, ends_at },
      })],
    });
  },
};

// --- 8. check_territory ------------------------------------------------------

export const checkTerritory = {
  descriptor: defineTool({
    name: 'check_territory',
    workflow_id: 'mcp_check_territory',
    description:
      'Check whether a location is inside the licensed service territory. '
      + 'Pass the county name and/or zip code extracted from a customer request. '
      + 'Returns licensed true/false plus the full licensed-area list (useful for a decline reply).',
    input_schema: 'exattime.check_territory.input/v1',
    output_schema: 'exattime.territory_check/v1',
    side_effect: 'read',
    requires_tenant: true,
  }),
  inputSchema: {
    ...ORG_ARG,
    county: z.string().optional().describe('County name, e.g. "Fairfield County, CT"'),
    zip: z.string().optional().describe('5-digit zip code'),
  },
  async body({ county, zip }, { context, port }) {
    if (!county && !zip) {
      return failed('invalid_input', 'provide county and/or zip', {
        audit: [{ step: 'validate_request', ok: false, detail: 'neither county nor zip supplied' }],
      });
    }
    const areas = await port.listServiceAreas({ org_id: context.org_id });
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const matched = areas.filter((a) => (
      (a.kind === 'county' && county && norm(a.value).includes(norm(county).replace(/county|ny|ct|nj/g, '')))
      || (a.kind === 'zip' && zip && a.value === zip)
    ));

    return succeeded({
      licensed: matched.length > 0,
      matched,
      licensed_areas: areas.map((a) => a.value),
    }, {
      audit: [
        { step: 'scope_tenant', ok: true, detail: context.org_id },
        { step: 'match_territory', ok: true, detail: matched.length > 0 ? 'licensed' : 'outside territory' },
      ],
      events: [toolEvent(context, {
        tool: 'check_territory', entity_type: 'service_area',
        payload: { licensed: matched.length > 0, by_county: Boolean(county), by_zip: Boolean(zip) },
      })],
    });
  },
};

// --- 9. find_best_worker -----------------------------------------------------

export const findBestWorker = {
  descriptor: defineTool({
    name: 'find_best_worker',
    workflow_id: 'mcp_find_best_worker',
    description:
      'Rank employees for a job by skill match, availability in the time window '
      + '(no conflicting shift), proximity to the job (from most recent GPS punch), and hourly rate. '
      + 'Use for dispatch decisions: "who should take this service call?"',
    input_schema: 'exattime.find_best_worker.input/v1',
    output_schema: 'exattime.worker_ranking/v1',
    side_effect: 'read',
    requires_tenant: true,
  }),
  inputSchema: {
    ...ORG_ARG,
    skill: z.string().optional().describe('Required specialty, e.g. "troubleshooting", "panel"'),
    when_start: z.string().describe('Job window start, ISO 8601'),
    when_end: z.string().describe('Job window end, ISO 8601'),
    near_lat: z.number().optional().describe('Job latitude (for proximity ranking)'),
    near_lng: z.number().optional().describe('Job longitude'),
  },
  async body({ skill, when_start, when_end, near_lat, near_lng }, { context, port, now }) {
    const since = new Date(Date.parse(now) - 14 * 864e5).toISOString();
    const [people, busy, punches] = await Promise.all([
      port.listEmployees({ org_id: context.org_id }),
      port.findShiftConflicts({ org_id: context.org_id, starts_at: when_start, ends_at: when_end }),
      port.listRecentPunches({ org_id: context.org_id, since }),
    ]);

    const busyIds = new Set(busy.map((s) => s.user_id));
    const lastPunch = new Map();
    for (const p of punches) if (!lastPunch.has(p.user_id)) lastPunch.set(p.user_id, p);

    const rad = (d) => (d * Math.PI) / 180;
    const distKm = (aLat, aLng, bLat, bLng) => 2 * 6371 * Math.asin(Math.sqrt(
      Math.sin(rad(bLat - aLat) / 2) ** 2
      + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2,
    ));

    const ranked = people.map((w) => {
      const punch = lastPunch.get(w.id);
      return {
        name: w.full_name,
        role: w.role,
        skills: w.skills,
        hourly_rate: w.hourly_rate,
        available_in_window: !busyIds.has(w.id),
        skill_match: skill ? (w.skills ?? []).some((s) => contains(s, skill)) : null,
        distance_km: near_lat != null && near_lng != null && punch
          ? +distKm(near_lat, near_lng, punch.in_lat, punch.in_lng).toFixed(1)
          : null,
        last_seen: punch?.clock_in ?? null,
      };
    }).sort((a, b) => (
      Number(b.available_in_window) - Number(a.available_in_window)
      || Number(b.skill_match ?? 0) - Number(a.skill_match ?? 0)
      || (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9)
      || (a.hourly_rate ?? 1e9) - (b.hourly_rate ?? 1e9)
      // Final tiebreak on name: two equally-ranked workers must not swap places
      // between two identical calls.
      || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    ));

    return succeeded({ ranked, count: ranked.length, window: { when_start, when_end } }, {
      audit: [
        { step: 'scope_tenant', ok: true, detail: context.org_id },
        { step: 'rank_workers', ok: true, detail: `${ranked.length} candidate(s)` },
      ],
      events: [toolEvent(context, {
        tool: 'find_best_worker', entity_type: 'user',
        payload: {
          candidate_count: ranked.length,
          available_count: ranked.filter((r) => r.available_in_window).length,
          by_skill: Boolean(skill),
          by_proximity: near_lat != null && near_lng != null,
        },
      })],
    });
  },
};

// --- 10. log_lead ------------------------------------------------------------

export const logLead = {
  descriptor: defineTool({
    name: 'log_lead',
    workflow_id: 'mcp_log_lead',
    description:
      'Log an inbound customer request (email/call) with its classification and disposition. '
      + 'Log EVERY request, including declines — this becomes demand and quoting data.',
    input_schema: 'exattime.log_lead.input/v1',
    output_schema: 'exattime.lead/v1',
    side_effect: 'write_internal',
    requires_tenant: true,
  }),
  inputSchema: {
    ...ORG_ARG,
    from_contact: z.string().optional().describe('Customer email or phone'),
    subject: z.string().optional(),
    summary: z.string().describe('One-sentence summary of the request'),
    address: z.string().optional(),
    county: z.string().optional(),
    zip: z.string().optional(),
    trade: z.string().optional().describe('Specialty needed, e.g. "troubleshooting"'),
    priority: z.enum(['p1_emergency', 'routine', 'quote']).default('routine'),
    disposition: z.enum(['dispatched', 'declined_territory', 'replied', 'pending']).default('pending'),
    notes: z.string().optional(),
  },
  async body(input, { context, port }) {
    // This is the tool that carried `orgs limit 1`. The tenant now arrives on
    // the context, resolved explicitly by the runtime, and `org_id` is stripped
    // from the payload so it can never be written from two places at once.
    const { org_id: _ignored, ...fields } = input;

    const created = await port.createLead({ org_id: context.org_id, ...fields });

    if (created.org_id !== context.org_id) {
      return failed('contract_violation', 'created lead is bound to a different tenant', {
        audit: [{ step: 'verify_tenant', ok: false, detail: 'org_id mismatch on the written row' }],
      });
    }

    return succeeded({ created }, {
      audit: [
        { step: 'scope_tenant', ok: true, detail: context.org_id },
        { step: 'write_lead', ok: true, detail: String(created.id) },
        { step: 'verify_tenant', ok: true, detail: created.org_id },
      ],
      // The lead's summary, contact and address are customer data and stay on
      // the row. The event records that a lead was logged, how it was
      // classified, and nothing a person said.
      events: [toolEvent(context, {
        tool: 'log_lead', entity_type: 'lead', entity_id: String(created.id),
        payload: {
          priority: created.priority,
          disposition: created.disposition,
          has_contact: Boolean(fields.from_contact),
          has_address: Boolean(fields.address),
        },
      })],
    });
  },
};

export const TOOLS = [
  getTimesheets, getFlags, getHoursReport, listJobSites, listEmployees,
  getSchedule, createShift, checkTerritory, findBestWorker, logLead,
];

export const TOOL_DESCRIPTORS = TOOLS.map((t) => t.descriptor);

#!/usr/bin/env node
// Exattime MCP server — exposes time-tracking data as tools for AI agents.
// Runs with the service-role key (trusted admin context): the agent layer is
// org-internal automation, not an end-user surface. Never register this
// server anywhere untrusted users can call it.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { createTenantDb, requireTenantId } from './tenant-db.js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const orgIdValue = process.env.MCP_ORG_ID;
if (!url || !key || !orgIdValue) {
  console.error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and MCP_ORG_ID must be set');
  process.exit(1);
}
let orgId;
try {
  orgId = requireTenantId(orgIdValue);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });
const tenantDb = createTenantDb(db, orgId);

const { data: assertedTenant, error: tenantError } = await db.rpc('assert_mcp_tenant', {
  p_org_id: orgId,
});
if (tenantError || assertedTenant !== orgId) {
  console.error(`MCP tenant assertion failed: ${tenantError?.message ?? 'tenant mismatch'}`);
  process.exit(1);
}

const server = new McpServer({ name: 'exattime', version: '0.0.1' });

function json(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(error) {
  return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
}

const ENTRY_SELECT =
  'id, clock_in, clock_out, status, in_geo_flag, out_geo_flag, notes, ' +
  'users!time_entries_user_id_fkey(full_name), job_sites(name), cost_codes(code, label)';

server.registerTool(
  'get_timesheets',
  {
    description:
      'List time entries between two dates, optionally filtered by employee name. ' +
      'Returns clock in/out times, hours, job site, cost code, GPS flags, and status.',
    inputSchema: {
      from: z.string().describe('Start date, YYYY-MM-DD'),
      to: z.string().describe('End date, YYYY-MM-DD'),
      employee: z.string().optional().describe('Filter by employee full name (partial match)'),
    },
  },
  async ({ from, to, employee }) => {
    let q = tenantDb
      .from('time_entries')
      .select(ENTRY_SELECT)
      .gte('clock_in', `${from}T00:00:00Z`)
      .lte('clock_in', `${to}T23:59:59Z`)
      .order('clock_in', { ascending: false });
    const { data, error } = await q;
    if (error) return fail(error);
    const rows = employee
      ? data.filter((r) =>
          r.users?.full_name?.toLowerCase().includes(employee.toLowerCase())
        )
      : data;
    return json(
      rows.map((r) => ({
        ...r,
        hours: r.clock_out
          ? +(((new Date(r.clock_out) - new Date(r.clock_in)) / 3.6e6).toFixed(2))
          : null,
      }))
    );
  }
);

server.registerTool(
  'get_flags',
  {
    description:
      'List anomalies needing human review: punches outside the job-site geofence, ' +
      'punches with no GPS, and entries left open (missing clock-out) for over 16 hours.',
    inputSchema: {
      days: z.number().int().min(1).max(90).default(14).describe('Look-back window in days'),
    },
  },
  async ({ days }) => {
    const from = new Date(Date.now() - days * 864e5).toISOString();
    const { data, error } = await tenantDb
      .from('time_entries')
      .select(ENTRY_SELECT)
      .gte('clock_in', from)
      .order('clock_in', { ascending: false });
    if (error) return fail(error);
    const flags = [];
    for (const r of data) {
      const who = r.users?.full_name ?? '?';
      const site = r.job_sites?.name ?? 'no site';
      if (r.in_geo_flag === 'outside')
        flags.push({ kind: 'outside_fence_in', who, site, entry: r });
      if (r.out_geo_flag === 'outside')
        flags.push({ kind: 'outside_fence_out', who, site, entry: r });
      if (r.in_geo_flag === 'no_gps')
        flags.push({ kind: 'no_gps', who, site, entry: r });
      if (!r.clock_out && Date.now() - new Date(r.clock_in) > 16 * 3.6e6)
        flags.push({ kind: 'missing_clock_out', who, site, entry: r });
    }
    return json(flags);
  }
);

server.registerTool(
  'get_hours_report',
  {
    description:
      'Aggregate completed hours between two dates, grouped by employee, job site, or cost code. ' +
      'Raw hours only — lunch deduction, overtime, and rounding are applied at payroll export.',
    inputSchema: {
      from: z.string().describe('Start date, YYYY-MM-DD'),
      to: z.string().describe('End date, YYYY-MM-DD'),
      group_by: z.enum(['employee', 'site', 'cost_code']).default('employee'),
    },
  },
  async ({ from, to, group_by }) => {
    const { data, error } = await tenantDb
      .from('time_entries')
      .select(ENTRY_SELECT)
      .gte('clock_in', `${from}T00:00:00Z`)
      .lte('clock_in', `${to}T23:59:59Z`)
      .not('clock_out', 'is', null);
    if (error) return fail(error);
    const keyOf = (r) =>
      group_by === 'employee'
        ? r.users?.full_name ?? '?'
        : group_by === 'site'
          ? r.job_sites?.name ?? 'no site'
          : (r.cost_codes ? `${r.cost_codes.code} — ${r.cost_codes.label}` : 'no code');
    const totals = new Map();
    for (const r of data) {
      const k = keyOf(r);
      const h = (new Date(r.clock_out) - new Date(r.clock_in)) / 3.6e6;
      const cur = totals.get(k) ?? { entries: 0, hours: 0 };
      cur.entries += 1;
      cur.hours += h;
      totals.set(k, cur);
    }
    return json(
      [...totals.entries()]
        .map(([k, v]) => ({ [group_by]: k, entries: v.entries, hours: +v.hours.toFixed(2) }))
        .sort((a, b) => b.hours - a.hours)
    );
  }
);

server.registerTool(
  'list_job_sites',
  {
    description: 'List job sites with geofence coordinates and radius.',
    inputSchema: {
      include_inactive: z.boolean().default(false),
    },
  },
  async ({ include_inactive }) => {
    let q = tenantDb.from('job_sites').select('id, name, address, lat, lng, radius_m, is_active');
    if (!include_inactive) q = q.eq('is_active', true);
    const { data, error } = await q.order('name');
    return error ? fail(error) : json(data);
  }
);

server.registerTool(
  'list_employees',
  {
    description: 'List employees with role and active status.',
    inputSchema: {
      include_inactive: z.boolean().default(false),
    },
  },
  async ({ include_inactive }) => {
    let q = tenantDb.from('users').select('id, full_name, role, is_active, hourly_rate');
    if (!include_inactive) q = q.eq('is_active', true);
    const { data, error } = await q.order('full_name');
    return error ? fail(error) : json(data);
  }
);

server.registerTool(
  'get_schedule',
  {
    description:
      'List scheduled shifts between two dates: who works when and at which job site. ' +
      'This is the schedule the M365 calendar sync mirrors.',
    inputSchema: {
      from: z.string().describe('Start date, YYYY-MM-DD'),
      to: z.string().describe('End date, YYYY-MM-DD'),
      include_cancelled: z.boolean().default(false),
    },
  },
  async ({ from, to, include_cancelled }) => {
    let q = tenantDb
      .from('shifts')
      .select(
        'id, starts_at, ends_at, status, notes, users!shifts_user_id_fkey(full_name), job_sites(name)'
      )
      .gte('starts_at', `${from}T00:00:00Z`)
      .lte('starts_at', `${to}T23:59:59Z`)
      .order('starts_at');
    if (!include_cancelled) q = q.neq('status', 'cancelled');
    const { data, error } = await q;
    return error ? fail(error) : json(data);
  }
);

server.registerTool(
  'create_shift',
  {
    description:
      'Schedule a shift for an employee. Names are matched case-insensitively against ' +
      'employees and job sites; the tool errors if a name is ambiguous or unknown.',
    inputSchema: {
      employee: z.string().describe('Employee full name'),
      job_site: z.string().optional().describe('Job site name'),
      starts_at: z.string().describe('Shift start, ISO 8601 (e.g. 2026-07-20T07:00:00-04:00)'),
      ends_at: z.string().describe('Shift end, ISO 8601'),
      notes: z.string().optional(),
    },
  },
  async ({ employee, job_site, starts_at, ends_at, notes }) => {
    const { data: users, error: uErr } = await tenantDb
      .from('users')
      .select('id, org_id, full_name')
      .ilike('full_name', `%${employee}%`)
      .eq('is_active', true);
    if (uErr) return fail(uErr);
    if (users.length !== 1) {
      return fail(new Error(`employee "${employee}" matched ${users.length} people`));
    }
    let siteId = null;
    if (job_site) {
      const { data: sites, error: sErr } = await tenantDb
        .from('job_sites')
        .select('id, name')
        .ilike('name', `%${job_site}%`)
        .eq('is_active', true);
      if (sErr) return fail(sErr);
      if (sites.length !== 1) {
        return fail(new Error(`job site "${job_site}" matched ${sites.length} sites`));
      }
      siteId = sites[0].id;
    }
    const { data, error } = await tenantDb
      .from('shifts')
      .insert({
        org_id: users[0].org_id,
        user_id: users[0].id,
        job_site_id: siteId,
        starts_at,
        ends_at,
        notes: notes ?? null,
      })
      .select('id, starts_at, ends_at')
      .single();
    return error ? fail(error) : json({ created: data, employee: users[0].full_name });
  }
);

server.registerTool(
  'check_territory',
  {
    description:
      'Check whether a location is inside the licensed service territory. ' +
      'Pass the county name and/or zip code extracted from a customer request. ' +
      'Returns licensed true/false plus the full licensed-area list (useful for a decline reply).',
    inputSchema: {
      county: z.string().optional().describe('County name, e.g. "Fairfield County, CT"'),
      zip: z.string().optional().describe('5-digit zip code'),
    },
  },
  async ({ county, zip }) => {
    if (!county && !zip) return fail(new Error('provide county and/or zip'));
    const { data, error } = await tenantDb.from('service_areas').select('kind, value, note');
    if (error) return fail(error);
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const matched = data.filter(
      (a) =>
        (a.kind === 'county' && county && norm(a.value).includes(norm(county).replace(/county|ny|ct|nj/g, ''))) ||
        (a.kind === 'zip' && zip && a.value === zip)
    );
    return json({
      licensed: matched.length > 0,
      matched,
      licensed_areas: data.map((a) => a.value),
    });
  }
);

server.registerTool(
  'find_best_worker',
  {
    description:
      'Rank employees for a job by skill match, availability in the time window ' +
      '(no conflicting shift), proximity to the job (from most recent GPS punch), and hourly rate. ' +
      'Use for dispatch decisions: "who should take this service call?"',
    inputSchema: {
      skill: z.string().optional().describe('Required specialty, e.g. "troubleshooting", "panel"'),
      when_start: z.string().describe('Job window start, ISO 8601'),
      when_end: z.string().describe('Job window end, ISO 8601'),
      near_lat: z.number().optional().describe('Job latitude (for proximity ranking)'),
      near_lng: z.number().optional().describe('Job longitude'),
    },
  },
  async ({ skill, when_start, when_end, near_lat, near_lng }) => {
    const [{ data: people, error: pErr }, { data: busy, error: bErr }, { data: punches, error: puErr }] =
      await Promise.all([
        tenantDb
          .from('users')
          .select('id, full_name, role, skills, hourly_rate')
          .eq('is_active', true),
        tenantDb
          .from('shifts')
          .select('user_id, starts_at, ends_at')
          .neq('status', 'cancelled')
          .lt('starts_at', when_end)
          .gt('ends_at', when_start),
        tenantDb
          .from('time_entries')
          .select('user_id, in_lat, in_lng, clock_in')
          .not('in_lat', 'is', null)
          .gte('clock_in', new Date(Date.now() - 14 * 864e5).toISOString())
          .order('clock_in', { ascending: false }),
      ]);
    if (pErr || bErr || puErr) return fail(pErr ?? bErr ?? puErr);

    const busyIds = new Set(busy.map((s) => s.user_id));
    const lastPunch = new Map();
    for (const p of punches) if (!lastPunch.has(p.user_id)) lastPunch.set(p.user_id, p);

    const rad = (d) => (d * Math.PI) / 180;
    const distKm = (aLat, aLng, bLat, bLng) =>
      2 *
      6371 *
      Math.asin(
        Math.sqrt(
          Math.sin(rad(bLat - aLat) / 2) ** 2 +
            Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2
        )
      );

    const ranked = people
      .map((w) => {
        const available = !busyIds.has(w.id);
        const skillMatch = skill
          ? (w.skills ?? []).some((s) => s.toLowerCase().includes(skill.toLowerCase()))
          : null;
        const punch = lastPunch.get(w.id);
        const distance_km =
          near_lat != null && near_lng != null && punch
            ? +distKm(near_lat, near_lng, punch.in_lat, punch.in_lng).toFixed(1)
            : null;
        return {
          name: w.full_name,
          role: w.role,
          skills: w.skills,
          hourly_rate: w.hourly_rate,
          available_in_window: available,
          skill_match: skillMatch,
          distance_km,
          last_seen: punch?.clock_in ?? null,
        };
      })
      .sort(
        (a, b) =>
          Number(b.available_in_window) - Number(a.available_in_window) ||
          Number(b.skill_match ?? 0) - Number(a.skill_match ?? 0) ||
          (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9) ||
          (a.hourly_rate ?? 1e9) - (b.hourly_rate ?? 1e9)
      );
    return json(ranked);
  }
);

server.registerTool(
  'log_lead',
  {
    description:
      'Log an inbound customer request (email/call) with its classification and disposition. ' +
      'Log EVERY request, including declines — this becomes demand and quoting data.',
    inputSchema: {
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
  },
  async (args) => {
    const { data, error } = await tenantDb
      .from('leads')
      .insert(args)
      .select('id, received_at, priority, disposition')
      .single();
    return error ? fail(error) : json(data);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('exattime MCP server running (stdio)');

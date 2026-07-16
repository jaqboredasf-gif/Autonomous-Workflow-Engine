#!/usr/bin/env node
// Exattime MCP server — exposes time-tracking data as tools for AI agents.
// Runs with the service-role key (trusted admin context): the agent layer is
// org-internal automation, not an end-user surface. Never register this
// server anywhere untrusted users can call it.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

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
    let q = db
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
    const { data, error } = await db
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
    const { data, error } = await db
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
    let q = db.from('job_sites').select('id, name, address, lat, lng, radius_m, is_active');
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
    let q = db.from('users').select('id, full_name, role, is_active, hourly_rate');
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
    let q = db
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
    const { data: users, error: uErr } = await db
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
      const { data: sites, error: sErr } = await db
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
    const { data, error } = await db
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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('exattime MCP server running (stdio)');

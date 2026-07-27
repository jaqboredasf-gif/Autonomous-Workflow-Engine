#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Exattime MCP server — the AWE kernel's first external execution surface.
//
// This file is WIRING ONLY. It reads env, chooses a data port, builds the sinks,
// registers the tool descriptors with the MCP SDK, and hands every call to
// `executeTool`. There is no business logic, no query, no error formatting and
// no tenant resolution here — all of that moved to modules that can be tested
// without a credential (see scripts/eval-mcp.mjs, Runner M).
//
// Two operating modes, fail-closed by default:
//
//   TEST (default)  Deterministic fixture data, in-process. No credential, no
//                   network, no live rows. Every response says `mode: "TEST"`
//                   and `is_fixture: true`, so a caller cannot mistake fixture
//                   output for production data.
//   LIVE            Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and an
//                   explicit tenant — AWE_ORG_ID on the process or `org_id` on
//                   the call. The server starts either way; a LIVE call without
//                   a tenant is REFUSED with `tenant_required`, not defaulted.
//
// Why the server no longer exits without credentials: it used to `process.exit(1)`
// on a missing key, which meant the tool surface could not be listed, described
// or tested anywhere the key was absent — including regression. A server that
// can enumerate its tools offline and refuses to touch live data without an
// explicit LIVE + tenant is both more testable and more fail-closed than one
// that dies at startup.
//
// The service-role key bypasses RLS. Never register this server anywhere
// untrusted users can call it.
// ---------------------------------------------------------------------------

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from '@supabase/supabase-js';

import { createFileArtifactSink, createFileAuditSink } from '../../awe-runtime/src/index.mjs';

import { createFixtureDataPort, createSupabaseDataPort } from './data-port.mjs';
import { FIXTURE_ROWS } from './fixtures.mjs';
import { executeTool } from './runtime.mjs';
import { resolveMode } from './tenant.mjs';
import { TOOLS } from './tools.mjs';

const env = process.env;
const mode = resolveMode(env);

// The live client is built ONLY in LIVE mode. In TEST the process holds no
// credential at all, which is a stronger statement than holding one and
// choosing not to use it.
let port;
if (mode === 'LIVE') {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('AWE_MODE=LIVE requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  port = createSupabaseDataPort(
    createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } }),
  );
} else {
  port = createFixtureDataPort({ rows: FIXTURE_ROWS });
}

// Durable evidence for every call. The local filesystem is the FIRST backend,
// not the permanent one — the sink interface is what lets a Supabase table or
// an object store replace it without a tool changing a line (ADR-0002 decides
// which, and is unresolved). `AWE_ARTIFACT_ROOT` lets an operator put the
// evidence somewhere other than the repo.
const artifactRoot = env.AWE_ARTIFACT_ROOT ?? 'artifacts';
const artifacts = createFileArtifactSink({ root: artifactRoot });
const audit = createFileAuditSink({ root: artifactRoot });

const server = new McpServer({ name: 'exattime', version: '0.1.0' });

for (const tool of TOOLS) {
  server.registerTool(
    tool.descriptor.name,
    {
      description: tool.descriptor.description,
      inputSchema: tool.inputSchema,
    },
    async (input) => {
      // The clock is read HERE, at the process boundary, and passed down. Every
      // layer below is deterministic given this instant, which is what makes a
      // run replayable from its artifact.
      const now = new Date().toISOString();
      const { response } = await executeTool({
        tool, input, deps: { port, env, now, artifacts, audit },
      });
      return response;
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `exattime MCP server running (stdio) — mode=${mode}, tools=${TOOLS.length}, `
  + `tenant=${env.AWE_ORG_ID ? 'bound via AWE_ORG_ID' : 'required per call'}`
  + `${mode === 'TEST' ? ', DATA IS FIXTURE' : ''}`,
);

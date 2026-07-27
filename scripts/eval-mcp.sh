#!/usr/bin/env bash
# Runner M — kernelized MCP execution surface.
#
# OFFLINE by construction: no API keys, no Supabase project, no service-role
# key, no network, no model call, no live rows, no n8n, no browser. Every tool
# runs against the deterministic two-tenant fixture data port, so the
# cross-tenant assertions are real rather than queries against an empty table.
#
# It proves: the `orgs limit 1` tenant defect is gone structurally and
# behaviourally; a call with no tenant is refused before any data access; every
# read tool is confined to its tenant; kernel outcomes map correctly onto MCP
# responses with a machine-readable code separate from the display message;
# audit events and durable reports carry no customer data or credentials; every
# path terminates in an explicit final state; MCP builds its context through the
# shared assembly boundary; and neither the tool descriptors nor the platform
# service layer carry an authorization decision (ADR-0002 stays blocked).
#
# The live MCP smoke test (initialize + tools/list over stdio) is a separate
# suite: scripts/smoke-mcp.sh.
#
# Usage: bash scripts/eval-mcp.sh
set -u
cd "$(dirname "$0")/.."

node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-mcp.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Runner M: PASS"
else
  echo "Runner M: FAIL (exit $rc)"
fi
exit "$rc"

#!/usr/bin/env bash
# MCP server smoke test — initialize + tools/list over stdio.
#
# Extracted verbatim from scripts/regression.sh so the step is a registered
# suite (packages/awe-kernel/src/registry.mjs: 'mcp-smoke') rather than an
# inline bash block only the regression script can run.
#
# Reads only: it lists the tool surface, it never calls a tool. Prints
# "OK (N tools)" and exits 0 when at least 10 tools are registered.
#
# Usage: bash scripts/smoke-mcp.sh
set -u
cd "$(dirname "$0")/.."

TOOLS=$( (printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"regression","version":"0"}}}' \
'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; sleep 2) | \
SUPABASE_URL=https://qgoiacwdntaqeghcyjlw.supabase.co node packages/mcp-server/src/index.js 2>/dev/null | \
jq -r 'select(.id==2) | .result.tools | length')

if [ "${TOOLS:-0}" -ge 10 ]; then
  echo "OK ($TOOLS tools)"
  exit 0
fi
echo "FAIL (tools=${TOOLS:-0})"
exit 1

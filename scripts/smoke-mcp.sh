#!/usr/bin/env bash
# MCP server smoke test — initialize + tools/list over stdio.
#
# Runs the real server binary over the real stdio transport and checks that it
# comes up and enumerates its tool surface. It lists tools; it never calls one.
#
# CREDENTIAL-FREE. The server starts in TEST mode by default and serves the
# deterministic fixture corpus, holding no Supabase URL and no service-role key
# at all — so this suite verifies the transport and the tool surface in any
# environment. It used to require both credentials because the old server exited
# at startup without them, which meant the one check that would have caught a
# broken tool registration could not run where it was most needed.
#
# Prints "OK (N tools)" and exits 0 when at least 10 tools are registered.
#
# Usage: bash scripts/smoke-mcp.sh
set -u
cd "$(dirname "$0")/.."

TOOLS=$( (printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"regression","version":"0"}}}' \
'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; sleep 2) | \
env -u SUPABASE_URL -u SUPABASE_SERVICE_ROLE_KEY -u AWE_MODE \
  node packages/mcp-server/src/index.js 2>/dev/null | \
jq -r 'select(.id==2) | .result.tools | length')

if [ "${TOOLS:-0}" -ge 10 ]; then
  echo "OK ($TOOLS tools)"
  exit 0
fi
echo "FAIL (tools=${TOOLS:-0})"
exit 1

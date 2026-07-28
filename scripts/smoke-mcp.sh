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
# It also drives ONE control-plane call end to end over the real transport —
# `start_workflow_run` against the synthetic reference workflow — because the
# offline suites exercise `executeTool` directly and would not catch a tool that
# fails to register, a schema the SDK rejects, or a response the transport
# cannot encode.
#
# Prints "OK (N tools, control plane reachable)" and exits 0.
#
# Usage: bash scripts/smoke-mcp.sh
set -u
cd "$(dirname "$0")/.."

# The synthetic reference tenant, which is the one the TEST-mode control plane
# registers a workflow for.
ORG=org_synthetic_alpha

OUT=$( (printf '%s\n' \
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"regression","version":"0"}}}' \
'{"jsonrpc":"2.0","method":"notifications/initialized"}' \
'{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
"{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"start_workflow_run\",\"arguments\":{\"org_id\":\"$ORG\",\"workflow_id\":\"invoice_intake_approval\"}}}" \
"{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"decide_approval\",\"arguments\":{\"org_id\":\"$ORG\",\"run_id\":\"whatever\",\"decision\":\"approve\"}}}"; sleep 3) | \
env -u SUPABASE_URL -u SUPABASE_SERVICE_ROLE_KEY -u AWE_MODE AWE_ARTIFACT_ROOT="${TMPDIR:-/tmp}/awe-smoke-$$" \
  node packages/mcp-server/src/index.js 2>/dev/null )

TOOLS=$(printf '%s' "$OUT" | jq -r 'select(.id==2) | .result.tools | length')
NAMES=$(printf '%s' "$OUT" | jq -r 'select(.id==2) | .result.tools[].name' | sort | tr '\n' ' ')
STARTED=$(printf '%s' "$OUT" | jq -r 'select(.id==3) | .result.content[0].text' | jq -r '.state // "none"')
DECIDED=$(printf '%s' "$OUT" | jq -r 'select(.id==4) | .result.content[0].text' | jq -r '.code // "none"')

rm -rf "${TMPDIR:-/tmp}/awe-smoke-$$"

fail() { echo "FAIL ($1)"; exit 1; }

[ "${TOOLS:-0}" -ge 16 ] || fail "tools=${TOOLS:-0}, expected at least 16"

# Named explicitly: a count alone passes when a control-plane tool is dropped
# and a data tool is added.
for required in list_workflows start_workflow_run get_run list_pending_approvals resume_run decide_approval; do
  case " $NAMES " in *" $required "*) ;; *) fail "tool '$required' is not registered" ;; esac
done

# The control plane really ran and really stopped at the human gate.
[ "$STARTED" = "paused" ] || fail "start_workflow_run returned state='$STARTED', expected 'paused' at the approval gate"

# And the surface still refuses to approve, over the real transport.
[ "$DECIDED" = "approval_actor_invalid" ] || fail "decide_approval returned code='$DECIDED', expected 'approval_actor_invalid' (G4)"

echo "OK ($TOOLS tools, control plane reachable, approval refused)"
exit 0

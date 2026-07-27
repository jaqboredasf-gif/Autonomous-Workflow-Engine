#!/usr/bin/env bash
# Runner E — DETERMINISTIC execution-outcome + durable-artifact eval.
#
# PURE OFFLINE by construction: no API keys, no model calls, no database, no
# network, no Microsoft Graph, no mailbox, no n8n, no browser. It drives the two
# real workflows — outbound drafting (B3) and email classification (B2) —
# through the shared run scaffolding, and asserts that every path (success,
# refusal, blocked routing, validation failure, internal error) returns a
# standardized outcome envelope with a machine-readable code, that no run can
# emit an approval or a send event, that no credential or personal data reaches
# an audit event, and that the run report is written atomically, deterministically
# and inside its artifact root.
#
# Classification runs against an injected in-memory database double, so the
# orchestration is exercised with zero credentials. The live keyword net and
# territory check remain Runner 2A's job.
#
# Artifacts are written to a self-cleaning scratch directory under $TMPDIR.
#
# Usage: bash scripts/eval-execution.sh
set -u
cd "$(dirname "$0")/.."

node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/eval-execution.mjs
rc=$?

if [ "$rc" = "0" ]; then
  echo "Runner E: PASS"
else
  echo "Runner E: FAIL (exit $rc)"
fi
exit "$rc"

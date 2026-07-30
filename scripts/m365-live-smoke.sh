#!/usr/bin/env bash
# OPT-IN live Microsoft 365 smoke test. DISABLED BY DEFAULT.
#
# This is the only script in the repo that can reach a real Microsoft tenant. It
# refuses to run unless every prerequisite is present (credentials, an explicit
# M365_LIVE_SMOKE=1 opt-in, and a config file naming the exact development
# resources it may touch) and prints a BLOCKED_LIVE_PROOF report otherwise.
#
# It is read-only unless M365_LIVE_ALLOW_DRAFT=1, and even then it can only
# create an unsent draft in the configured development mailbox — no capability
# to send exists in packages/m365 at any version.
#
# NEVER add this to scripts/regression.sh.
#
# Usage:
#   M365_LIVE_SMOKE=1 \
#   M365_TENANT_ID=... M365_CLIENT_ID=... M365_CLIENT_SECRET=... \
#   M365_ALLOWLIST_PATH=config/m365-allowlist.json \
#   M365_SMOKE_MAILBOX=dev-intake@<tenant>.onmicrosoft.com \
#   M365_SMOKE_MESSAGE_ID=AAMk... \
#   bash scripts/m365-live-smoke.sh
set -u
cd "$(dirname "$0")/.."

node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/m365-live-smoke.mjs
rc=$?

case "$rc" in
  0) echo "M365 live smoke: PASS" ;;
  2) echo "M365 live smoke: BLOCKED_LIVE_PROOF (nothing was attempted)" ;;
  *) echo "M365 live smoke: FAIL (exit $rc)" ;;
esac
exit "$rc"

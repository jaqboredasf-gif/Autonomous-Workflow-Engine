#!/usr/bin/env bash
set -euo pipefail

handoff="docs/planning/AGENT_HANDOFF.md"

if [[ ! -f "$handoff" ]]; then
  echo "FAIL: missing $handoff" >&2
  exit 1
fi

required_headings=(
  updated_at
  agent
  repository
  branch
  commit
  "active task"
  "completed work"
  "files changed"
  migrations
  "commands run"
  "tests passed"
  "tests failed"
  "live changes"
  "approvals required"
  risks
  blockers
  "exact next prompt"
)

for heading in "${required_headings[@]}"; do
  if ! grep -Fqx "## $heading" "$handoff"; then
    echo "FAIL: missing required heading: ## $heading" >&2
    exit 1
  fi
done

# Reject recognizable credential values while allowing credential names,
# redaction markers, and documentation about secret handling.
secret_pattern='(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sbp_[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})'
if grep -En "$secret_pattern" "$handoff" >/dev/null; then
  echo "FAIL: handoff contains a value matching a secret pattern" >&2
  exit 1
fi

if grep -Eni '(password|secret|token|api[_-]?key)[[:space:]]*[:=][[:space:]]*[^[:space:]<${][^[:space:]]{7,}' "$handoff" >/dev/null; then
  echo "FAIL: handoff contains a possible assigned secret value" >&2
  exit 1
fi

echo "PASS: agent handoff contains all required headings and no detected secret values"

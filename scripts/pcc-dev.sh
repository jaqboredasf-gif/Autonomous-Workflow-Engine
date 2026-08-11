#!/usr/bin/env bash
# Start the PCC development server the way it is meant to run locally:
# Supabase auth and Supabase persistence, against the local stack.
#
# WHY A SCRIPT AND NOT .env.local: Next loads .env.local for EVERY invocation,
# including the acceptance suite, which starts its own server and expects the
# local file-backed provider. A committed convenience file silently reconfigured
# the tests. This sets the environment for one process instead.
#
# The keys come from the running Supabase containers, so there is nothing to
# copy by hand and no secret in the repository.
set -euo pipefail

PORT="${PORT:-3100}"
CONTAINER="${SUPABASE_STUDIO_CONTAINER:-supabase_studio_exattime}"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "The local Supabase stack is not running (container $CONTAINER not found)." >&2
  echo "Start it first, or set SUPABASE_STUDIO_CONTAINER." >&2
  exit 1
fi

export AUTH_PROVIDER=supabase
export PURCHASING_PERSISTENCE=supabase
export NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$(docker exec "$CONTAINER" printenv SUPABASE_ANON_KEY)"
export SUPABASE_SERVICE_ROLE_KEY="$(docker exec "$CONTAINER" printenv SUPABASE_SERVICE_KEY)"
export SESSION_SECRET="${SESSION_SECRET:-local-development-session-secret-at-least-32-characters}"
export APP_BASE_URL="http://localhost:${PORT}"
export AUTH_REDIRECT_URL="http://localhost:${PORT}/reset-password"

echo "PCC on http://localhost:${PORT}  (supabase auth + persistence)"
exec npm run dev -w purchasing -- -p "$PORT"

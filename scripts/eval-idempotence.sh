#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# eval-idempotence.sh — can PCC be deployed twice without losing anything?
#
# A deployment procedure is only safe if doing it AGAIN is safe, because it will
# be done again: an operator re-runs the install after a failure, forgets to
# remove a first-install variable, or replaces the application files to roll a
# release forward. None of those may touch the company's purchasing records.
#
# This puts a real purchasing system into a container and then does every
# repeat-deployment action to it, checking after each one that nothing was lost:
#
#   1. restart the same container                     (the ordinary case)
#   2. restart with PCC_DATABASE_ALLOW_CREATE=1 STILL SET
#      — the operator forgot to remove it after the first install. This is the
#        dangerous one: the flag authorizes creating a database, and it must not
#        cause an existing one to be replaced.
#   3. DESTROY and RECREATE the container from the image against the same volume
#      — which is what a release upgrade actually is
#   4. run the environment validation and startup a further time
#
# After each, the full verification runs again: users, vendors, jobs, the
# request, the PO NUMBER, the receipt, both attachments byte-for-byte, the audit
# history, and the PO sequence position.
#
#   bash scripts/eval-idempotence.sh
#
# Exit 0 means repeat deployment is non-destructive.
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

NAME=pcc-idempotence
VOL=pcc-idempotence-data
IMAGE=pcc:idempotence
PORT=${PORT:-3404}
ORG="Idempotence Test Co."

export ACCEPTANCE_BASE_URL="http://localhost:${PORT}"
export PCC_ADMIN_EMAIL="admin@idempotence.test"
export PCC_ADMIN_PASSWORD="idempotence-admin-password-2026"
export PCC_FINGERPRINT="${TMPDIR:-/tmp}/pcc-idempotence-fingerprint.json"

SECRET="$(openssl rand -base64 48)"
step() { echo ""; echo "=== $* ==="; }
fatal() { echo ""; echo "IDEMPOTENCE: FAIL — $*"; exit 1; }

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1
  docker volume rm "$VOL" >/dev/null 2>&1
  rm -f "$PCC_FINGERPRINT"
}
trap cleanup EXIT
cleanup

step "checking the port is free"
node --input-type=module -e "
  const { requireFreePort } = await import('${ROOT}/scripts/lib/port-guard.mjs');
  await requireFreePort('http://localhost:${PORT}');
  console.log('port ${PORT} is free');
" || fatal "port ${PORT} is occupied"

step "building the image"
docker build -t "$IMAGE" . >/dev/null 2>&1 || fatal "the image did not build"
echo "built $IMAGE"

wait_for_health() {
  for _ in $(seq 1 60); do
    curl -fsS "${ACCEPTANCE_BASE_URL}/api/health" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# `start_pcc <extra docker args...>` — the same image, same volume, every time.
start_pcc() {
  docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:3000" -v "${VOL}:/data" \
    -e NODE_ENV=production \
    -e SESSION_SECRET="$SECRET" \
    -e PCC_DATABASE_PATH=/data/pcc.sqlite \
    -e APP_BASE_URL="$ACCEPTANCE_BASE_URL" \
    -e PCC_ORG_NAME="$ORG" \
    -e PCC_PO_NUMBERING=job-vendor-sequence \
    "$@" \
    "$IMAGE" >/dev/null
}

verify() {
  node scripts/eval-restore-rehearsal.mjs --verify || fatal "$1"
}

# --- first install ----------------------------------------------------------
step "first install"
docker volume create "$VOL" >/dev/null
start_pcc -e PCC_DATABASE_ALLOW_CREATE=1 \
          -e PCC_BOOTSTRAP_ADMIN_EMAIL="$PCC_ADMIN_EMAIL" \
          -e PCC_BOOTSTRAP_ADMIN_PASSWORD="$PCC_ADMIN_PASSWORD" \
  || fatal "the container did not start"
wait_for_health || { docker logs "$NAME" 2>&1 | tail -20; fatal "never became healthy"; }
docker logs "$NAME" 2>&1 | grep '\[pcc\]'

step "putting a real purchasing system in"
node scripts/eval-restore-rehearsal.mjs --write || fatal "could not build the system"

# --- 1. ordinary restart ----------------------------------------------------
step "1/4 — restarting the same container"
docker restart "$NAME" >/dev/null
wait_for_health || fatal "did not come back after restart"
docker logs "$NAME" 2>&1 | grep '\[pcc\]' | tail -2
verify "a plain restart lost data"

# --- 2. the forgotten first-install flag ------------------------------------
# THE DANGEROUS ONE. PCC_DATABASE_ALLOW_CREATE authorizes creating a database.
# An operator who leaves it set after the first install must not thereby
# authorize replacing the one that now exists.
step "2/4 — restarting with PCC_DATABASE_ALLOW_CREATE=1 still set"
docker rm -f "$NAME" >/dev/null
start_pcc -e PCC_DATABASE_ALLOW_CREATE=1 || fatal "the container did not start"
wait_for_health || fatal "never became healthy"
LOG=$(docker logs "$NAME" 2>&1 | grep '\[pcc\]')
echo "$LOG" | tail -2
if echo "$LOG" | grep -q 'creating a NEW purchasing database'; then
  fatal "IT CREATED A NEW DATABASE over an existing one — the flag is not idempotent"
fi
echo "  ok  it opened the existing database rather than creating one"
verify "leaving ALLOW_CREATE set destroyed data"

# --- 3. a release upgrade ---------------------------------------------------
# Destroying the container and recreating it from the image IS the upgrade
# procedure: the application is replaced, the volume is not.
step "3/4 — destroying and recreating the container (a release upgrade)"
docker rm -f "$NAME" >/dev/null
start_pcc || fatal "the container did not start"
wait_for_health || fatal "never became healthy"
docker logs "$NAME" 2>&1 | grep '\[pcc\]' | tail -2
verify "replacing the application lost data"

# --- 4. once more, for the migration path -----------------------------------
# Migrations run on every start. Running them a fourth time must still be a
# no-op, and the schema version must still agree with the code.
step "4/4 — one more start, to exercise the migration path again"
docker restart "$NAME" >/dev/null
wait_for_health || fatal "did not come back"
HEALTH=$(curl -fsS "${ACCEPTANCE_BASE_URL}/api/health")
echo "$HEALTH" | grep -q '"migrations":{"ok":true}' \
  && echo "  ok  migrations still report healthy after four starts" \
  || fatal "migrations no longer report healthy: $HEALTH"
verify "a fourth start lost data"

echo ""
echo "IDEMPOTENCE: PASS — repeat deployment is non-destructive across all four cases."

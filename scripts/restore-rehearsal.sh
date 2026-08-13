#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# restore-rehearsal.sh — prove a backup can become a working purchasing system.
#
# This is the drill described in docs/deployment/PCC_IT_DEPLOYMENT_HANDOFF.md
# §8, run end to end and automatically, so the answer is evidence rather than
# an intention. It:
#
#   1. builds the production image
#   2. starts a SOURCE instance on its own volume, and fills it with a real
#      purchasing system — two users, a vendor, a job, a request with an
#      ATTACHMENT, an approved PO, a receipt with a packing slip
#   3. takes a backup with scripts/pcc-backup.mjs, the way IT would
#   4. creates a THROWAWAY volume and restores the backup into it with
#      scripts/pcc-restore.mjs
#   5. starts a SECOND instance against the restored data, on another port
#   6. verifies every one of those facts through the web interface, including
#      downloading the attachments and comparing them byte for byte
#   7. proves the SOURCE was never touched
#   8. removes everything it made
#
# Nothing here runs against a real deployment: it builds its own containers and
# volumes with distinct names, and refuses to start if anything is already
# answering on the ports it wants.
#
#   bash scripts/restore-rehearsal.sh
#
# Exit 0 means a backup of PCC can be restored into a working PCC.
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

SRC_NAME=pcc-rehearsal-source
DST_NAME=pcc-rehearsal-restored
SRC_VOL=pcc-rehearsal-source-data
DST_VOL=pcc-rehearsal-restored-data
IMAGE=pcc:rehearsal
SRC_PORT=${SRC_PORT:-3402}
DST_PORT=${DST_PORT:-3403}
ORG="Restore Rehearsal Inc."

export PCC_ADMIN_EMAIL="admin@rehearsal.test"
export PCC_ADMIN_PASSWORD="rehearsal-admin-password-2026"
export PCC_FINGERPRINT="${TMPDIR:-/tmp}/pcc-restore-fingerprint.json"
export PCC_EXPECTED_ORG="$ORG"

step() { echo ""; echo "=== $* ==="; }
fatal() { echo ""; echo "REHEARSAL FAILED: $*"; exit 1; }

cleanup() {
  docker rm -f "$SRC_NAME" "$DST_NAME" >/dev/null 2>&1
  docker volume rm "$SRC_VOL" "$DST_VOL" >/dev/null 2>&1
  rm -f "$PCC_FINGERPRINT"
}
trap cleanup EXIT
cleanup

# --- 0. the ports must be OURS ---------------------------------------------
# A container left over from an earlier run answers on the same port and makes
# every later check report on the wrong application. Refuse rather than guess.
step "checking the ports are free"
node --input-type=module -e "
  const { requireFreePort } = await import('${ROOT}/scripts/lib/port-guard.mjs');
  await requireFreePort('http://localhost:${SRC_PORT}');
  await requireFreePort('http://localhost:${DST_PORT}');
  console.log('ports ${SRC_PORT} and ${DST_PORT} are free');
" || fatal "a port is occupied — see above"

step "building the production image"
docker build -t "$IMAGE" . >/dev/null 2>&1 || {
  docker build -t "$IMAGE" . 2>&1 | tail -30
  fatal "the image did not build"
}
echo "built $IMAGE"

wait_for_health() {
  local url=$1
  for _ in $(seq 1 60); do
    curl -fsS "${url}/api/health" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

# --- 1. the source system ---------------------------------------------------
step "starting the SOURCE instance (a first install)"
docker volume create "$SRC_VOL" >/dev/null
docker run -d --name "$SRC_NAME" -p "127.0.0.1:${SRC_PORT}:3000" -v "${SRC_VOL}:/data" \
  -e NODE_ENV=production \
  -e SESSION_SECRET="$(openssl rand -base64 48)" \
  -e PCC_DATABASE_PATH=/data/pcc.sqlite \
  -e APP_BASE_URL="http://localhost:${SRC_PORT}" \
  -e PCC_DATABASE_ALLOW_CREATE=1 \
  -e PCC_ORG_NAME="$ORG" \
  -e PCC_BOOTSTRAP_ADMIN_EMAIL="$PCC_ADMIN_EMAIL" \
  -e PCC_BOOTSTRAP_ADMIN_PASSWORD="$PCC_ADMIN_PASSWORD" \
  "$IMAGE" >/dev/null || fatal "the source container did not start"

wait_for_health "http://localhost:${SRC_PORT}" || {
  docker logs "$SRC_NAME" 2>&1 | tail -20
  fatal "the source instance never became healthy"
}
docker logs "$SRC_NAME" 2>&1 | grep '\[pcc\]'

step "putting a real purchasing system into the SOURCE"
ACCEPTANCE_BASE_URL="http://localhost:${SRC_PORT}" \
  node scripts/eval-restore-rehearsal.mjs --write || fatal "could not build the source system"

# --- 2. the backup ----------------------------------------------------------
# Run exactly as documented: a throwaway container, as the application's own
# uid, against the live volume, while PCC KEEPS SERVING.
step "taking a backup while the SOURCE keeps running"
docker run --rm -v "${SRC_VOL}:/data" -v "${ROOT}/scripts:/scripts:ro" --user 1000:1000 \
  node:24-bookworm-slim \
  node /scripts/pcc-backup.mjs --db /data/pcc.sqlite --out /data/backups || fatal "the backup failed"

BACKUP=$(docker run --rm -v "${SRC_VOL}:/data" node:24-bookworm-slim \
  sh -c 'ls -1t /data/backups/*.sqlite 2>/dev/null | head -1' | tr -d '\r')
[ -n "$BACKUP" ] || fatal "no backup file was produced"
echo "backup: $BACKUP"

# --- 3. the restore ---------------------------------------------------------
step "restoring into a THROWAWAY volume"
docker volume create "$DST_VOL" >/dev/null
# The backup is copied from the source volume (read-only) into the new one, then
# restored in place — which is the shape of a real recovery: the backup arrives
# from wherever IT keeps it, and the restore runs against a stopped instance.
docker run --rm -v "${SRC_VOL}:/src:ro" -v "${DST_VOL}:/data" -v "${ROOT}/scripts:/scripts:ro" \
  node:24-bookworm-slim sh -c "
    cp '/src/${BACKUP#/data/}' /tmp/incoming.sqlite &&
    node /scripts/pcc-restore.mjs --from /tmp/incoming.sqlite --db /data/pcc.sqlite
  " || fatal "the restore failed"

# The restored file must be writable by the user the application runs as. A
# restore performed as root leaves a database the app cannot write, and the next
# start fails with 'attempt to write a readonly database'.
docker run --rm -v "${DST_VOL}:/data" node:24-bookworm-slim chown -R 1000:1000 /data

step "verifying the restored DATABASE before trusting it"
docker run --rm -v "${DST_VOL}:/data" -v "${ROOT}/scripts:/scripts:ro" \
  node:24-bookworm-slim node /scripts/pcc-verify-production.mjs --db /data/pcc.sqlite
echo "(the verifier reports rehearsal data as unfit for REAL work — that is correct)"

# --- 4. does it actually work? ---------------------------------------------
step "starting PCC against the RESTORED data"
# NOTE: no PCC_DATABASE_ALLOW_CREATE. If the restore did not put a database
# where PCC looks, this start REFUSES rather than quietly creating an empty one
# — which is exactly the behaviour a real recovery needs.
docker run -d --name "$DST_NAME" -p "127.0.0.1:${DST_PORT}:3000" -v "${DST_VOL}:/data" \
  -e NODE_ENV=production \
  -e SESSION_SECRET="$(openssl rand -base64 48)" \
  -e PCC_DATABASE_PATH=/data/pcc.sqlite \
  -e APP_BASE_URL="http://localhost:${DST_PORT}" \
  -e PCC_ORG_NAME="$ORG" \
  "$IMAGE" >/dev/null || fatal "the restored container did not start"

wait_for_health "http://localhost:${DST_PORT}" || {
  docker logs "$DST_NAME" 2>&1 | tail -20
  fatal "PCC did not come up against the restored database"
}
docker logs "$DST_NAME" 2>&1 | grep '\[pcc\]'

step "verifying the RESTORED application, as the people who use it"
ACCEPTANCE_BASE_URL="http://localhost:${DST_PORT}" \
  node scripts/eval-restore-rehearsal.mjs --verify
VERIFY=$?

# --- 5. the source must be untouched ---------------------------------------
# A restore that quietly damages the system it was taken from is worse than no
# backup at all. Ask the SOURCE the same question afterwards.
step "confirming the SOURCE was never touched"
SRC_HEALTH=$(curl -fsS "http://localhost:${SRC_PORT}/api/health" || echo '{}')
echo "$SRC_HEALTH" | grep -q '"status":"ok"' \
  && echo "  ok  the source is still healthy" \
  || { echo "  FAIL the source is not healthy: $SRC_HEALTH"; VERIFY=1; }

SRC_REPLACED=$(docker run --rm -v "${SRC_VOL}:/data" node:24-bookworm-slim \
  sh -c 'ls -1 /data/*.replaced-* 2>/dev/null | wc -l' | tr -d ' \r')
[ "$SRC_REPLACED" = "0" ] \
  && echo "  ok  the source database was never moved aside" \
  || { echo "  FAIL the restore touched the source volume"; VERIFY=1; }

echo ""
if [ "$VERIFY" = "0" ]; then
  echo "RESTORE REHEARSAL: PASS — a backup of PCC restores into a working PCC."
else
  echo "RESTORE REHEARSAL: FAIL"
fi
exit "$VERIFY"

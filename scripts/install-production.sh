#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# install-production.sh — the deterministic half of a PCC installation.
#
# SCOPE, STATED FIRST, BECAUSE THE SCOPE IS THE POINT.
#
# This automates only what PCC owns and what has exactly one right answer:
# checking prerequisites, validating configuration, building the image,
# starting the container, and verifying health. It is the Docker path
# (Branch A of PCC_VM_INSTALLATION_RUNBOOK.md), which is the preferred one.
#
# IT DELIBERATELY DOES NOT:
#
#   · configure a firewall, DNS, HTTPS or a reverse proxy — infrastructure,
#     and Lippolis IT's to own
#   · generate or store any secret — a secret a script invented is a secret
#     nobody put in a secret store
#   · create the data directory — creating it is how a typo becomes a new empty
#     database beside the real one. It must already exist, deliberately.
#   · initialize the purchase order sequence — that number comes from the paper
#     book and inventing one is the single most expensive mistake available
#   · touch, reset or migrate an existing database beyond the idempotent
#     migrations the application runs on every start
#   · delete a backup
#   · install a supervision unit or reboot anything
#
# Everything it will not do is in the runbook, with the reason. THE RUNBOOK IS
# STILL THE INSTALLATION DOCUMENT — this is a way to execute its deterministic
# steps without typing them, not a replacement for reading it.
#
#   bash scripts/install-production.sh --env /etc/pcc.env --data /var/lib/pcc
#   bash scripts/install-production.sh --env /etc/pcc.env --data /var/lib/pcc --first-install
#
#   --env            the environment file. REQUIRED. Never in the repository.
#   --data           the persistent data directory. REQUIRED, and must exist.
#   --first-install  acknowledge that this start may CREATE the database.
#   --dry-run        print what would happen and change nothing.
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

ENV_FILE=""
DATA_DIR=""
FIRST_INSTALL=0
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE="${2:-}"; shift 2 ;;
    --data) DATA_DIR="${2:-}"; shift 2 ;;
    --first-install) FIRST_INSTALL=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "install-production: unknown argument $1"; exit 2 ;;
  esac
done

step() { echo ""; echo "=== $* ==="; }
fatal() { echo ""; echo "INSTALL FAILED: $*"; echo "Nothing has been changed by this script."; exit 1; }
run() { if [ "$DRY_RUN" = "1" ]; then echo "  would run: $*"; else "$@"; fi; }

[ -n "$ENV_FILE" ] || fatal "--env <file> is required. See .env.example for what goes in it."
[ -n "$DATA_DIR" ] || fatal "--data <dir> is required. It is the directory that must survive redeploys."
[ -f "$ENV_FILE" ] || fatal "no environment file at $ENV_FILE"

# --- 1. the data directory must ALREADY exist ------------------------------
# Creating it here is exactly the failure that must not happen: a typo in the
# path becomes a new, empty, healthy-looking purchasing system while the real
# records sit unmounted somewhere else. An operator creating it deliberately is
# the check.
step "checking the persistent data directory"
[ -d "$DATA_DIR" ] || fatal "$DATA_DIR does not exist.
  Create it deliberately, so a mistyped path cannot become a second empty database:
      sudo install -d -o 1000 -g 1000 -m 750 $DATA_DIR"
echo "  ok  $DATA_DIR exists"

# --- 2. and it must NOT be inside this checkout ----------------------------
# `git clean -xfd`, a re-clone, or a release that replaces the application
# directory would delete the records and the backups beside them. The
# application refuses this too (infrastructure/sqlite/database-location.ts);
# this catches it before anything is built.
DATA_ABS="$(cd "$DATA_DIR" && pwd -P)"
ROOT_ABS="$(cd "$ROOT" && pwd -P)"
case "$DATA_ABS/" in
  "$ROOT_ABS"/*)
    fatal "$DATA_ABS is inside the source checkout at $ROOT_ABS.
  The purchasing records must not live in a git working tree — 'git clean -xfd', a re-clone,
  or replacing the application directory during a release would delete them AND the backups.
  Use a path of its own, for example /var/lib/pcc." ;;
esac
echo "  ok  the data directory is outside the source checkout"

# --- 3. prerequisites -------------------------------------------------------
step "checking prerequisites"
command -v docker >/dev/null 2>&1 || fatal "docker is not installed or not on PATH.
  This script is the container path (Branch A). If Lippolis IT does not permit a container
  runtime, follow Branch B in PCC_VM_INSTALLATION_RUNBOOK.md instead."
docker compose version >/dev/null 2>&1 || fatal "'docker compose' is unavailable (is this an old docker-compose?)"
docker info >/dev/null 2>&1 || fatal "the docker daemon is not reachable by this user"
echo "  ok  docker $(docker --version | awk '{print $3}' | tr -d ,) with compose"

# --- 4. configuration -------------------------------------------------------
# Read from the env file WITHOUT echoing values: this output gets pasted into
# tickets and installation records.
step "validating configuration (values are never printed)"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE" || fatal "could not read $ENV_FILE"
set +a

[ "${NODE_ENV:-}" = "production" ] || fatal "NODE_ENV must be 'production' in $ENV_FILE (found '${NODE_ENV:-unset}')"
[ -n "${SESSION_SECRET:-}" ] || fatal "SESSION_SECRET is not set. Generate one with: openssl rand -base64 48
  This script will NOT generate it for you — a secret invented by a script is a secret nobody stored."
[ "${#SESSION_SECRET}" -ge 32 ] || fatal "SESSION_SECRET is shorter than 32 characters"
[ -n "${PCC_DATABASE_PATH:-}" ] || fatal "PCC_DATABASE_PATH is not set"
[ -n "${APP_BASE_URL:-}" ] || fatal "APP_BASE_URL is not set — password-reset links need it"
echo "  ok  the four required variables are set"

if [ -n "${PCC_BOOTSTRAP_ADMIN_PASSWORD:-}" ] && [ "$FIRST_INSTALL" = "0" ]; then
  echo "  !!  PCC_BOOTSTRAP_ADMIN_PASSWORD is set but this is not --first-install."
  echo "      Remove it from $ENV_FILE once the first administrator exists."
fi

# --- 5. would this start CREATE a database? --------------------------------
step "checking what this start would do to the database"
DB_FILE="$DATA_DIR/$(basename "$PCC_DATABASE_PATH")"
if [ -f "$DB_FILE" ]; then
  echo "  ok  an existing database is present — this start will OPEN it"
  echo "      $(ls -lh "$DB_FILE" | awk '{print $5}') at $DB_FILE"
  if [ "${PCC_DATABASE_ALLOW_CREATE:-}" = "1" ]; then
    echo "  !!  PCC_DATABASE_ALLOW_CREATE=1 is set with a database already present."
    echo "      It is tested as non-destructive, but remove it — it is for the first start only."
  fi
elif [ "$FIRST_INSTALL" = "1" ]; then
  echo "  !!  NO DATABASE FOUND, and --first-install was given."
  echo "      This start will CREATE the company's purchasing database. That should happen once, ever."
  [ "${PCC_DATABASE_ALLOW_CREATE:-}" = "1" ] || fatal "PCC_DATABASE_ALLOW_CREATE=1 must also be set in $ENV_FILE for a first install"
else
  fatal "no database at $DB_FILE, and --first-install was not given.
  If this really is the first installation, re-run with --first-install (and set
  PCC_DATABASE_ALLOW_CREATE=1 in the environment file).
  If it is NOT, then the data directory is wrong — and starting would serve an empty
  purchasing system beside the real one."
fi

# --- 6. the read-only preflight --------------------------------------------
step "running the preflight (read-only)"
node scripts/pcc-preflight.mjs --data "$DATA_DIR" --port "${PORT:-3000}" || fatal "the preflight found problems — fix them and run this again"

# --- 7. build ---------------------------------------------------------------
# check-deployable.mjs runs INSIDE the build and fails it if a database, key or
# .env would be shipped in the image.
step "building the production image"
run docker compose build || fatal "the image did not build"
echo "  ok  built, and the package contains no database, key or environment file"

# --- 8. start ---------------------------------------------------------------
step "starting PCC"
run docker compose up -d || fatal "the container did not start"

if [ "$DRY_RUN" = "1" ]; then
  echo ""
  echo "--dry-run: nothing was built, started or changed."
  exit 0
fi

# --- 9. verify --------------------------------------------------------------
step "verifying health"
HEALTH_URL="http://127.0.0.1:${PORT:-3000}"
for _ in $(seq 1 60); do
  curl -fsS "${HEALTH_URL}/api/health" >/dev/null 2>&1 && break
  sleep 2
done

READY=$(curl -fsS "${HEALTH_URL}/api/health" 2>/dev/null || echo '')
LIVE=$(curl -fsS "${HEALTH_URL}/api/health/live" 2>/dev/null || echo '')

echo ""
docker compose logs pcc 2>&1 | grep '\[pcc\]' || true
echo ""

case "$READY" in
  *'"status":"ok"'*) echo "  ok  readiness: healthy" ;;
  '') fatal "readiness did not answer. Check: docker compose logs pcc" ;;
  *) fatal "readiness reports a problem: $READY" ;;
esac
case "$LIVE" in
  *alive*) echo "  ok  liveness: alive" ;;
  *) fatal "liveness did not answer" ;;
esac

# --- 10. what this script will not do for you ------------------------------
cat <<'NEXT'

=== INSTALLED. The rest is not automatable — do these by hand ===

  1. Sign in as the bootstrap administrator through the HTTPS address,
     and CHANGE THE TEMPORARY PASSWORD.

  2. Remove PCC_DATABASE_ALLOW_CREATE and PCC_BOOTSTRAP_ADMIN_PASSWORD from the
     environment file, then restart. The log must then say
     "opening the existing purchasing database".

  3. Install process supervision so PCC survives a reboot:
        sudo cp deploy/pcc-docker.service /etc/systemd/system/pcc.service
        sudo systemctl daemon-reload && sudo systemctl enable --now pcc

  4. REBOOT THE VM and confirm PCC comes back with nobody logging in.

  5. Take the first backup, and run the restore rehearsal on this machine:
        bash scripts/restore-rehearsal.sh

  6. Fill in the installation record in PCC_VM_INSTALLATION_RUNBOOK.md.

  NOT DONE BY THIS SCRIPT, and not by any script:
     · the purchase order sequence — it comes from the office's paper book,
       and PCC refuses to issue a PO until an administrator sets it
     · HTTPS, DNS, the reverse proxy, the firewall — Lippolis IT
     · the backup schedule — Lippolis IT's platform

NEXT

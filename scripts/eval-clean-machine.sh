#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# eval-clean-machine.sh — does PCC install on a machine that is not Jack's?
#
# THE ASSUMPTION THIS EXISTS TO BREAK. Every previous verification ran in this
# repository, on a laptop that already had node_modules installed, a built
# .next directory, a populated .data database, and whatever else four months of
# development leaves behind. A build that quietly depends on any of that works
# perfectly here and fails on the Lippolis VM, at the worst possible moment,
# with an error about something nobody has thought about since June.
#
# So this exports the repository to a temporary directory containing ONLY
# repository content — no node_modules, no build output, no local database, not
# even .git — and runs the whole lifecycle from there:
#
#   · the export is INSPECTED to prove it carries nothing developed-in
#   · the image builds from it (npm ci, in a container, from the lockfile)
#   · the preflight runs in a clean node:24 container with no repository
#   · PCC starts with production configuration, data OUTSIDE the source tree
#   · health, backup, restore into a fresh volume, and full verification
#
#   bash scripts/eval-clean-machine.sh
#
# Exit 0 means the installation does not depend on this developer's machine.
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
EXPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pcc-clean-machine-XXXXXX")"

step() { echo ""; echo "=== $* ==="; }
fatal() { echo ""; echo "CLEAN MACHINE: FAIL — $*"; exit 1; }

cleanup() { rm -rf "$EXPORT_DIR"; }
trap cleanup EXIT

# --- 1. export only what a fresh clone would have --------------------------
step "exporting the repository to a clean directory"
rsync -a \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.next' \
  --exclude '.data' \
  --exclude '*.sqlite' --exclude '*.db' --exclude '*.db-wal' --exclude '*.db-shm' \
  --exclude '.env' --exclude '.env.*' \
  --include '.env.example' \
  "$ROOT/" "$EXPORT_DIR/" || fatal "the export failed"
echo "exported to $EXPORT_DIR"

# --- 2. prove the export is actually clean ---------------------------------
# Checking rather than trusting the exclude list: a stray node_modules is
# exactly the thing that would make this test pass for the wrong reason.
step "proving the export carries nothing from this machine"
for forbidden in node_modules .next .data .git; do
  if find "$EXPORT_DIR" -name "$forbidden" -maxdepth 4 | grep -q .; then
    fatal "the export contains $forbidden — it is not a clean tree"
  fi
  echo "  ok  no $forbidden"
done
if find "$EXPORT_DIR" \( -name '*.sqlite' -o -name '*.db' \) | grep -q .; then
  fatal "the export contains a database file"
fi
echo "  ok  no database files"
[ -f "$EXPORT_DIR/package-lock.json" ] || fatal "no package-lock.json in the export — npm ci would be non-deterministic"
echo "  ok  package-lock.json present (npm ci installs exactly this)"

# --- 3. the preflight, in a container with no repository -------------------
# Proves the preflight script itself has no dependency on the checkout, on
# installed packages, or on anything but Node.
step "running the preflight in a clean node:24 container"
docker run --rm \
  -v "$EXPORT_DIR/scripts:/scripts:ro" \
  -v "$EXPORT_DIR/apps/purchasing:/app:ro" \
  node:24-bookworm-slim \
  node /scripts/pcc-preflight.mjs --data /tmp --port 3000 \
  || fatal "the preflight does not run on a clean machine"

# --- 4. the whole lifecycle, from the clean export -------------------------
# restore-rehearsal.sh builds the image from the directory it is run in, stands
# up a source instance, fills it with a real purchasing system, backs it up,
# restores into a throwaway volume, starts a second instance and verifies every
# record, credential, permission and attachment through the web interface.
#
# Run from the EXPORT, so every one of those steps happens against a tree that
# has never had a developer in it.
step "building and running the full lifecycle from the clean export"
cd "$EXPORT_DIR" || fatal "could not enter the export"
bash scripts/restore-rehearsal.sh || fatal "the lifecycle failed when run from a clean tree"

echo ""
echo "CLEAN MACHINE: PASS — the build and the full backup/restore lifecycle work"
echo "                     from a tree containing only repository content."

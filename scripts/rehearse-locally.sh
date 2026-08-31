#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# rehearse-locally.sh — install PCC on this machine, the way it will be
# installed on the server, and drive a real purchase through it.
#
# WHAT THIS IS FOR. Every other suite tests a part. This runs the whole
# sequence an installation actually performs, against the packaged production
# artifact over a real process boundary:
#
#   fresh state -> configuration -> database created -> first start ->
#   a complete purchase -> concurrent double-press -> shutdown -> restart ->
#   persistence -> the value projection -> shutdown
#
# IT DECLARES ITSELF A REHEARSAL, and that is the whole point of the flag. The
# artifact, the company name, the address that prints on a purchase order and
# the organization id are all the real ones — a rehearsal that changed them
# would not be rehearsing anything — so the database it leaves behind is
# indistinguishable from production by inspection. `PCC_ENVIRONMENT=rehearsal`
# is stamped into it at creation, once, and after that:
#
#   * the case-study reader refuses it as evidence unless asked by name, and
#     stamps NOT EVIDENCE across the output when it is;
#   * the organization value view withholds every hours and money figure;
#   * the database can never be promoted to production, because the stamp is
#     written once and a later start that disagrees refuses to boot.
#
# So this cannot contaminate production claims even if somebody later points a
# reporting command at the file by mistake.
#
# WHAT IT DOES NOT PROVE. Nothing here is Windows. It exercises the
# platform-neutral application — Node, the store, the HTTP surface, the
# workflow — and says nothing about installing a Windows service, IIS, or a
# scheduled backup task. Those are proven by the first supervised installation
# on LIPELE-RDS02 and by nothing else. See docs/deployment/PCC_RDS02_EXECUTION_PACKAGE.md.
#
#   bash scripts/rehearse-locally.sh [--keep]
#
# --keep leaves the rehearsal database in place for inspection.
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PORT=${PCC_REHEARSAL_PORT:-3477}
DATA=${PCC_REHEARSAL_DIR:-$(mktemp -d -t pcc-rehearsal)}
SERVER=apps/purchasing/.next/standalone/apps/purchasing/server.js
KEEP=0; [ "${1:-}" = "--keep" ] && KEEP=1
fails=0
step() { echo; echo "=== $1 ${*:2}"; }
note() { echo "    $*"; }
# A PIPELINE'S EXIT STATUS IS THE LAST COMMAND'S. `... | tail -4` reports tail's
# success and hides the suite's failure, which is how this script first reported
# COMPLETE while step 3 had refused to run at all.
run_step() { local name="$1"; shift; "$@" > "$DATA/$name.out" 2>&1; local c=$?; tail -4 "$DATA/$name.out" | sed 's/^/    /'; [ $c = 0 ] || { echo "    STEP FAILED (exit $c)"; fails=$((fails+1)); }; }

[ -f "$SERVER" ] || { echo "no production build at $SERVER"; echo "run: npm run build --workspace purchasing"; exit 1; }

# REFUSE TO SHARE A PORT. A rehearsal that silently talks to a server somebody
# else started reports that server's behaviour, passes, and proves nothing —
# which is exactly what happened the first time this was run by hand.
if command -v lsof >/dev/null 2>&1 && lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "port $PORT is already in use. Refusing to rehearse against a server this script did not start."
  echo "Set PCC_REHEARSAL_PORT to a free port, or stop what is listening."
  exit 1
fi

rm -rf "$DATA"; mkdir -p "$DATA"
export NODE_ENV=production PORT HOSTNAME=127.0.0.1
export APP_BASE_URL="http://pcc.rehearsal.invalid"
export PCC_ALLOW_INSECURE_HTTP=1
export SESSION_SECRET="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
export PCC_DATABASE_PATH="$DATA/pcc.sqlite" PCC_DATABASE_ALLOW_CREATE=1
# THE TWO THAT ARE WRITTEN ONCE. `rehearsal` is what makes everything below
# unquotable; `lippolis` is the real tenant id, because measuring a rehearsal
# against a different id would rehearse the wrong thing.
export PCC_ENVIRONMENT=rehearsal
export PCC_ORG_ID=lippolis
export PCC_ORG_NAME="Lippolis Electric, Inc."
export PCC_ORG_ADDRESS="Licensed Electrical Contractor · 25 Seventh Street, Pelham, NY 10803"
export PCC_ORG_PHONE="(914) 738-3550"
export PCC_PO_NUMBERING=job-vendor-sequence
export PCC_BOOTSTRAP_ADMIN_EMAIL=admin@rehearsal.invalid
export PCC_BOOTSTRAP_ADMIN_PASSWORD='RehearsalAdmin!2026'
export PCC_RELEASE="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

start() {
  node "$SERVER" > "$DATA/server-$1.log" 2>&1 &
  echo $! > "$DATA/pid"
  for _ in $(seq 1 90); do
    curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "THE SERVER DID NOT COME UP"; tail -30 "$DATA/server-$1.log"; return 1
}
stop() { [ -f "$DATA/pid" ] || return 0; kill "$(cat "$DATA/pid")" 2>/dev/null; sleep 1; kill -9 "$(cat "$DATA/pid")" 2>/dev/null; rm -f "$DATA/pid"; }
trap 'stop' EXIT

step "1. FIRST START — a machine that has never run PCC"
start first || exit 1
grep -E "creating a NEW|environment |organization id declared|bootstrap administrator" "$DATA/server-first.log" | sed 's/^/    /'
curl -fsS "http://127.0.0.1:$PORT/api/health" | sed 's/^/    /'; echo

step "2. A COMPLETE PURCHASE — the day-one sequence, on an empty database"
# The cold-start suite signs in on the bootstrap password, is forced to replace
# it, and leaves the administrator on PCC_ADMIN_OWN_PASSWORD. Step 3 has to
# start from there, so both are exported once rather than passed twice.
export PCC_BASE_URL="http://127.0.0.1:$PORT"
export PCC_ADMIN_EMAIL="$PCC_BOOTSTRAP_ADMIN_EMAIL"
export PCC_ADMIN_PASSWORD="$PCC_BOOTSTRAP_ADMIN_PASSWORD"
# What the two accounts end up on after the forced first-sign-in password
# change. Stated rather than left to defaults, because step 3 signs in with
# them and PCC_ADMIN_PASSWORD — the bootstrap one — is dead by then.
export PCC_ADMIN_OWN_PASSWORD='TheAdministratorPicked!2026'
export PCC_MIKE_PASSWORD='MikePicksThisOne!2026'
run_step coldstart node scripts/eval-production-coldstart.mjs

step "3. SOMEBODY PRESSES TWICE — genuinely concurrent requests"
run_step idempotency node scripts/eval-production-idempotency.mjs

step "4. SHUTDOWN"
stop; note "stopped"

step "5. RESTART — the same database, with the first-install variables removed"
unset PCC_DATABASE_ALLOW_CREATE PCC_BOOTSTRAP_ADMIN_PASSWORD
start second || exit 1
if grep -q "opening the existing purchasing database" "$DATA/server-second.log"; then
  note "opening the existing purchasing database"
else
  echo "    IT DID NOT OPEN THE EXISTING DATABASE — the data path is wrong"; fails=$((fails+1))
fi

step "6. PERSISTENCE — what survived the restart"
node -e '
const {DatabaseSync} = require("node:sqlite");
const db = new DatabaseSync(process.env.PCC_DATABASE_PATH, {readOnly: true});
for (const t of ["orgs","users","vendors","jobs","purchase_requests","purchase_orders","purchase_receipts","purchase_activity_log"]) {
  try { console.log("   ", t.padEnd(24), db.prepare("select count(*) as n from " + t).get().n); } catch { }
}
const stamp = db.prepare("select value from schema_meta where key = \x27environment\x27").get()?.value;
const org = db.prepare("select id, name from orgs limit 1").get();
console.log("    environment stamp        ", stamp);
console.log("    organization             ", org.id, "/", org.name);
if (stamp !== "rehearsal") { console.log("    THE STAMP IS NOT rehearsal"); process.exit(1); }
' || fails=$((fails+1))

step "7. THE VALUE PROJECTION — and its refusal"
if node scripts/proof-case-study.mjs --org lippolis --from 2026-01-01 --to 2027-01-01 \
     --db "$DATA/pcc.sqlite" >/dev/null 2>&1; then
  echo "    THE READER ACCEPTED A REHEARSAL DATABASE AS EVIDENCE"; fails=$((fails+1))
else
  note "the case-study reader refused the rehearsal database"
fi
node scripts/proof-case-study.mjs --org lippolis --from 2026-01-01 --to 2027-01-01 \
  --db "$DATA/pcc.sqlite" --allow-nonproduction 2>&1 | sed -n '1,6p;/Human hours returned/p;/Labour value/p' | sed 's/^/    /'

step "8. SHUTDOWN"
stop

echo
if [ "$KEEP" = "1" ]; then
  echo "rehearsal database kept at $DATA/pcc.sqlite (stamped rehearsal — it can never become evidence)"
else
  rm -rf "$DATA"
fi
echo "local rehearsal: $([ $fails = 0 ] && echo 'COMPLETE — the application installs, runs, restarts and persists' || echo "$fails STEP(S) FAILED")"
echo "NOT PROVEN HERE: the Windows service, IIS, and the scheduled backup task. Those need LIPELE-RDS02."
[ "$fails" = "0" ]

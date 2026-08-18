#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# eval-backup-timer.sh — does the scheduled backup actually run under systemd?
#
# `eval-backup-operations.mjs` proves the backup COMMAND is correct and that the
# unit files say the right things. Neither of those is the question that matters
# at 01:30 on the VM, which is whether systemd starts the unit, whether the unit
# can read its environment file, whether the service account can write to the
# backup directory, and whether a failure is visible afterwards.
#
# So this stands up a real systemd inside a container, installs the units the
# way the handoff tells IT to install them, and asks:
#
#   1. the timer is enabled, active, and reports a next run
#   2. `systemctl start pcc-backup.service` produces a VERIFIED backup file
#   3. the journal carries the evidence, under the identifier the handoff names
#   4. a backup that cannot work leaves the unit FAILED rather than passing
#      quietly — the whole point of a scheduled job nobody watches
#   5. the timer fires ON ITS OWN, on a schedule, without anybody starting it
#
# (5) uses a drop-in that overrides OnCalendar to every-30-seconds. The nightly
# calendar itself is not something a test can wait for; what is worth proving is
# that a timer expiry starts the service and the service does its job.
#
# WHAT THIS IS NOT: proof on Lippolis hardware. It is proof that the units are
# correct systemd, that they work when installed as documented, and that they
# fail loudly. The VM still has to run `systemctl enable --now pcc-backup.timer`
# once, and be rebooted.
#
#   bash scripts/eval-backup-timer.sh
#
# Requires Docker with --privileged (systemd needs it to be PID 1). Exits 0 only
# if every check passes. Removes the container it made.
# ---------------------------------------------------------------------------
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

NAME=pcc-backup-timer-eval
IMAGE=node:24-bookworm

pass=0
fails=()
ok()   { pass=$((pass+1)); echo "  ok  $1"; }
bad()  { fails+=("$1"); echo "FAIL  $1${2:+ — $2}"; }
check(){ if [ "$1" = "0" ]; then ok "$2"; else bad "$2" "${3:-}"; fi; }

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if ! docker info >/dev/null 2>&1; then
  echo "eval-backup-timer: Docker is not available. SKIPPED (this suite proves nothing without it)."
  exit 2
fi

cleanup
echo "=== starting a container with systemd as PID 1 ==="
docker run -d --name "$NAME" --privileged \
  --tmpfs /run --tmpfs /run/lock -v /sys/fs/cgroup:/sys/fs/cgroup:rw --cgroupns=host \
  -v "$ROOT/scripts:/repo/scripts:ro" \
  -v "$ROOT/deploy:/repo/deploy:ro" \
  -v "$ROOT/apps:/repo/apps:ro" \
  "$IMAGE" /bin/bash -c \
  'apt-get update -qq && apt-get install -y -qq systemd systemd-sysv >/dev/null && exec /lib/systemd/systemd' \
  >/dev/null || { echo "eval-backup-timer: could not start the container"; exit 1; }

x() { docker exec "$NAME" bash -c "$1"; }

echo "=== waiting for systemd ==="
for _ in $(seq 1 60); do
  if x 'systemctl is-system-running 2>/dev/null | grep -qE "running|degraded"'; then break; fi
  sleep 2
done
x 'systemctl is-system-running || true'

echo ""
echo "=== installing PCC's backup units the way the handoff says to ==="
# The service account, the data directory, the scripts, the environment file —
# exactly the four things §8a tells IT to create.
x 'useradd --system --home /opt/pcc --shell /usr/sbin/nologin pcc' >/dev/null 2>&1
# The unit's ExecStart is /usr/bin/node, which is where a distribution package
# puts it. This image ships Node at /usr/local/bin/node.
x 'ln -sf /usr/local/bin/node /usr/bin/node'
x 'install -d -o pcc -g pcc -m 750 /opt/pcc/scripts /var/lib/pcc /var/lib/pcc/backups'
x 'install -o pcc -g pcc -m 750 /repo/scripts/pcc-backup.mjs /repo/scripts/pcc-restore.mjs /repo/scripts/pcc-reset-admin.mjs /repo/scripts/pcc-storage-status.mjs /opt/pcc/scripts/'
x 'printf "PCC_DATABASE_PATH=/var/lib/pcc/pcc.sqlite\n" > /etc/pcc.env && chown root:pcc /etc/pcc.env && chmod 640 /etc/pcc.env'

# A REAL PCC DATABASE — the application's own schema and seed, not a stand-in.
# The backup opens what it wrote and counts organizations, requests and purchase
# orders, so a three-table imitation would prove less than it appears to.
x 'node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --input-type=module -e "
const { openDatabase } = await import(\"/repo/apps/purchasing/src/purchasing/infrastructure/sqlite/database.ts\");
const { seed } = await import(\"/repo/apps/purchasing/src/purchasing/infrastructure/seed.ts\");
const db = openDatabase(\"/var/lib/pcc/pcc.sqlite\");
seed(db, new Date().toISOString());
db.close();
"'
check $? "a real PCC database exists for the backup to take"
x 'chown pcc:pcc /var/lib/pcc/pcc.sqlite*'

x 'cp /repo/deploy/pcc-backup.service /etc/systemd/system/pcc-backup.service'
x 'cp /repo/deploy/pcc-backup.timer   /etc/systemd/system/pcc-backup.timer'
x 'systemctl daemon-reload'

echo ""
echo "--- the timer, as Jose would install it -------------------------"
x 'systemctl enable --now pcc-backup.timer' >/dev/null 2>&1
check $? "systemctl enable --now pcc-backup.timer succeeds"

x 'systemctl is-active pcc-backup.timer | grep -q active'
check $? "the timer is active"

x 'systemctl is-enabled pcc-backup.timer | grep -q enabled'
check $? "and enabled, so it survives a reboot"

x 'systemctl list-timers pcc-backup.timer --all | grep -q pcc-backup'
check $? "systemctl list-timers shows it, which is how Jose inspects it"

echo ""
echo "--- a backup run by hand through the unit -----------------------"
x 'systemctl start pcc-backup.service'
check $? "systemctl start pcc-backup.service runs a backup now"

x 'test "$(ls /var/lib/pcc/backups/*.sqlite 2>/dev/null | wc -l)" -ge 1'
check $? "a backup file exists afterwards" "$(x 'ls /var/lib/pcc/backups' 2>&1)"

x 'journalctl -u pcc-backup --no-pager | grep -q "verified — integrity ok"'
check $? "the journal says the backup was verified, not merely written"

x 'journalctl -t pcc-backup --no-pager | grep -q "pcc-backup:"'
check $? "and it is findable by the SyslogIdentifier the handoff names"

x 'stat -c "%U" "$(ls -t /var/lib/pcc/backups/*.sqlite | head -1)" | grep -q "^pcc$"'
check $? "the backup is owned by the service account, not root"

x 'systemctl show pcc-backup.service -p Result --value | grep -q success'
check $? "the unit reports success"

echo ""
echo "--- verifying the latest backup, the way §8a documents ----------"
x 'runuser -u pcc -- node /opt/pcc/scripts/pcc-backup.mjs --db /var/lib/pcc/pcc.sqlite --check | grep -q "verified — integrity ok"'
check $? "--check verifies the newest backup as the service account"

echo ""
echo "--- and when it cannot work, it FAILS LOUDLY --------------------"
x 'mv /var/lib/pcc/pcc.sqlite /var/lib/pcc/pcc.sqlite.hidden'
x 'systemctl start pcc-backup.service' >/dev/null 2>&1
x 'systemctl is-failed pcc-backup.service | grep -q failed'
check $? "a backup of a database that is not there leaves the unit FAILED"

x 'systemctl --failed --no-pager | grep -q pcc-backup'
check $? "so it shows up in systemctl --failed"

x 'journalctl -u pcc-backup --no-pager | tail -20 | grep -q "no database at"'
check $? "and the journal says why"

x 'mv /var/lib/pcc/pcc.sqlite.hidden /var/lib/pcc/pcc.sqlite && systemctl reset-failed pcc-backup.service'

echo ""
echo "--- the timer firing on its own ---------------------------------"
# A drop-in, so the shipped unit is unchanged: prove that a timer EXPIRY starts
# the service. The nightly calendar cannot be waited for.
x 'mkdir -p /etc/systemd/system/pcc-backup.timer.d && printf "[Timer]\nOnCalendar=\nOnUnitActiveSec=20s\nOnBootSec=20s\nRandomizedDelaySec=0\nAccuracySec=1s\n" > /etc/systemd/system/pcc-backup.timer.d/fast.conf'
x 'systemctl daemon-reload && systemctl restart pcc-backup.timer'
BEFORE=$(x 'ls /var/lib/pcc/backups/*.sqlite | wc -l' | tr -d ' \r')
echo "  (waiting up to 90s for the timer to fire on its own; $BEFORE backup(s) now)"
FIRED=1
for _ in $(seq 1 45); do
  NOW=$(x 'ls /var/lib/pcc/backups/*.sqlite | wc -l' | tr -d ' \r')
  if [ "$NOW" -gt "$BEFORE" ]; then FIRED=0; break; fi
  sleep 2
done
check "$FIRED" "the timer starts the backup with nobody logged in" "still $BEFORE backup(s)"

x 'journalctl -u pcc-backup.timer --no-pager | tail -5' >/dev/null 2>&1

echo ""
echo "--- and the production verifier reads all of that ----------------"
# THE VERIFIER'S systemd CHECKS ARE UNVERIFIABLE ON A DEVELOPER'S MACHINE, which
# is exactly the reason to run them here: this container has real systemd, the
# real units, and a real database. Application checks are expected to BLOCK —
# no PCC is running in here — so the assertions are on the specific rows rather
# than the exit code.
# Run it straight out of the mounted repository: /repo holds scripts, apps and
# deploy, which is the layout the script derives its own root from.
x 'PCC_DATABASE_PATH=/var/lib/pcc/pcc.sqlite NODE_ENV=production \
     SESSION_SECRET=a-secret-that-must-not-be-printed-0123456789012345 \
     APP_BASE_URL=https://pcc.invalid PCC_PO_NUMBERING=job-vendor-sequence \
     node /repo/scripts/pcc-verify-deployment.mjs --json > /tmp/verify.json 2>/tmp/verify.err; true'
x 'test -s /tmp/verify.json'
check $? "the verifier runs on the server and emits a report" "$(x 'tail -5 /tmp/verify.err' 2>&1)"

x 'node -e "const r=JSON.parse(require(\"node:fs\").readFileSync(\"/tmp/verify.json\",\"utf8\"));
  const c=Object.values(r.sections).flatMap(s=>s.checks);
  const get=id=>c.find(x=>x.id===id)?.status;
  const need={\"timer.active\":\"PASS\",\"timer.enabled\":\"PASS\",\"timer.last_result\":\"PASS\"};
  for(const [id,want] of Object.entries(need)){ if(get(id)!==want){ console.error(id+\" is \"+get(id)+\", wanted \"+want); process.exit(1);} }
  process.exit(0)"'
check $? "the verifier reports the timer as active, enabled and last-run-successful" "$(x 'cat /tmp/verify.err' 2>&1 | tail -3)"

x 'grep -q "a-secret-that-must-not-be-printed" /tmp/verify.json /tmp/verify.err'
if [ $? -ne 0 ]; then ok "and prints no secret into its report"; else bad "and prints no secret into its report" "the session secret appeared in the output"; fi

x 'node -e "const r=JSON.parse(require(\"node:fs\").readFileSync(\"/tmp/verify.json\",\"utf8\"));
  const c=Object.values(r.sections).flatMap(x=>x.checks);
  const s=c.find(x=>x.id===\"service.active\")?.status;
  process.exit(s===\"BLOCKED\"?0:1)"'
check $? "and reports the absent PCC service as BLOCKED rather than assuming it is fine"

echo ""
if [ ${#fails[@]} -gt 0 ]; then
  for f in "${fails[@]}"; do echo "FAILED: $f"; done
  echo "backup timer checks: $pass passed, ${#fails[@]} failed"
  exit 1
fi
echo "backup timer checks: $pass passed, 0 failed"
echo "SCHEDULED BACKUP: PASS — the units install, run, verify, fail loudly, and fire on their own."

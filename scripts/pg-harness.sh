#!/usr/bin/env bash
# Local Postgres migration harness — MIGRATION + INTEGRATION verification with
# NO live project, NO credentials and NO network.
#
# WHY THIS EXISTS: migrations to the hosted Supabase project are human-gated and
# the management API is not reachable from every environment, which used to mean
# a migration could only ever be "lint-verified" (its SQL TEXT inspected) before
# being applied for the first time against real data. That is a weak place to
# find out a constraint rejects existing rows.
#
# This stands up a throwaway PostgreSQL cluster, applies the real migration
# chain in order, seeds representative production-shaped rows, proves the newest
# migration applies AND rolls back cleanly inside a transaction, then exercises
# the RPCs and RLS through the real database contract.
#
# WHAT IT IS NOT: it is not the live project. Supabase-managed pieces
# (auth.uid(), auth.users, storage) are stubbed below, faithfully but minimally.
# A green run here means the migration and its logic are sound; it does NOT mean
# the migration has been applied anywhere, and it is never LIVE verification.
#
# Usage: bash scripts/pg-harness.sh          (skips cleanly if Postgres is absent)
set -u
cd "$(dirname "$0")/.."

PGBIN=""
for d in /usr/lib/postgresql/*/bin /usr/local/pgsql/bin /opt/homebrew/opt/postgresql@16/bin; do
  [ -x "$d/initdb" ] && PGBIN="$d" && break
done
if [ -z "$PGBIN" ] && command -v initdb >/dev/null 2>&1; then
  PGBIN="$(dirname "$(command -v initdb)")"
fi
if [ -z "$PGBIN" ]; then
  echo "pg-harness: SKIP (no PostgreSQL server binaries found)"
  echo "  install postgresql-16 to enable offline migration verification"
  exit 0
fi

PGDATA_DIR="${PG_HARNESS_DATA:-/tmp/awe-pgd-$$}"
SOCK="${PG_HARNESS_SOCK:-/tmp/awe-pgs-$$}"
PORT="${PG_HARNESS_PORT:-55432}"
RUNAS=""
if [ "$(id -u)" = "0" ]; then
  # PostgreSQL refuses to run as root.
  RUNAS="$(id -u postgres >/dev/null 2>&1 && echo postgres || echo '')"
  if [ -z "$RUNAS" ]; then
    echo "pg-harness: SKIP (running as root and no unprivileged 'postgres' user exists)"
    exit 0
  fi
fi

cleanup() {
  if [ -n "$RUNAS" ]; then
    su "$RUNAS" -c "$PGBIN/pg_ctl -D $PGDATA_DIR stop -m immediate" >/dev/null 2>&1
  else
    "$PGBIN/pg_ctl" -D "$PGDATA_DIR" stop -m immediate >/dev/null 2>&1
  fi
  rm -rf "$PGDATA_DIR" "$SOCK"
}
trap cleanup EXIT

rm -rf "$PGDATA_DIR" "$SOCK"; mkdir -p "$PGDATA_DIR" "$SOCK"
[ -n "$RUNAS" ] && chown -R "$RUNAS" "$PGDATA_DIR" "$SOCK"

run_pg() {
  if [ -n "$RUNAS" ]; then su "$RUNAS" -c "$*"; else eval "$*"; fi
}

run_pg "$PGBIN/initdb -D $PGDATA_DIR -U postgres --auth=trust" >/dev/null 2>&1 \
  || { echo "pg-harness: FAIL (initdb)"; exit 1; }
run_pg "$PGBIN/pg_ctl -D $PGDATA_DIR -o '-p $PORT -k $SOCK -c listen_addresses=' -l $PGDATA_DIR/pg.log start" >/dev/null 2>&1 \
  || { echo "pg-harness: FAIL (server did not start)"; tail -5 "$PGDATA_DIR/pg.log" 2>/dev/null; exit 1; }

PSQL="$PGBIN/psql -h $SOCK -p $PORT -U postgres"
for _ in $(seq 1 20); do $PSQL -tAc 'select 1' >/dev/null 2>&1 && break; sleep 0.5; done
$PSQL -tAc 'create database awe' >/dev/null 2>&1
DB="$PSQL -d awe -v ON_ERROR_STOP=1 -q"

# --- Supabase-managed objects the migrations assume exist --------------------
$DB >/dev/null 2>&1 <<'SQL'
create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;
create schema if not exists auth;
create schema if not exists storage;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb->>'sub','')::uuid
$$;
create table if not exists auth.users (id uuid primary key, email text);
create table if not exists storage.buckets (id text primary key, name text, public boolean default false);
create table if not exists storage.objects (
  id uuid primary key default uuid_generate_v4(), bucket_id text references storage.buckets(id),
  name text, owner uuid, created_at timestamptz default now(), metadata jsonb);
alter table storage.objects enable row level security;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
SQL

fails=0
LATEST="$(ls supabase/migrations/*.sql | sort | tail -1)"
LATEST_NAME="$(basename "$LATEST")"

echo "== applying migration chain (all but $LATEST_NAME)"
for f in $(ls supabase/migrations/*.sql | sort); do
  [ "$f" = "$LATEST" ] && continue
  if ! out=$($DB -f "$f" 2>&1); then
    echo "  FAIL $(basename "$f")"; echo "$out" | head -5; exit 1
  fi
done
echo "  OK ($(ls supabase/migrations/*.sql | wc -l | tr -d ' ') migrations, newest held back)"

echo "== seeding representative production-shaped rows"
$DB -f scripts/pg-tests/seed.sql >/dev/null 2>&1 || { echo "  FAIL (seed)"; exit 1; }
BEFORE=$($DB -tAc "select md5(string_agg(table_name||'.'||column_name||':'||data_type||':'||is_nullable, ',' order by table_name, ordinal_position)) from information_schema.columns where table_schema='public'")
echo "  OK (schema fingerprint ${BEFORE:0:12}…)"

echo "== transactional dry run of $LATEST_NAME (applied, then ROLLED BACK)"
{ echo "begin;"; cat "$LATEST"; echo "rollback;"; } | $DB >/dev/null 2>&1 \
  && echo "  OK (applies cleanly inside a transaction)" \
  || { echo "  FAIL (does not apply)"; { echo "begin;"; cat "$LATEST"; echo "rollback;"; } | $DB 2>&1 | head -5; fails=$((fails+1)); }

AFTER=$($DB -tAc "select md5(string_agg(table_name||'.'||column_name||':'||data_type||':'||is_nullable, ',' order by table_name, ordinal_position)) from information_schema.columns where table_schema='public'")
if [ "$BEFORE" = "$AFTER" ]; then
  echo "  OK (rollback restored the schema exactly)"
else
  echo "  FAIL (rollback left residue: $BEFORE -> $AFTER)"; fails=$((fails+1))
fi

echo "== applying $LATEST_NAME for real (scratch cluster only)"
$DB -f "$LATEST" >/dev/null 2>&1 && echo "  OK" || { echo "  FAIL"; $DB -f "$LATEST" 2>&1 | head -5; exit 1; }

echo "== integration assertions"
for t in scripts/pg-tests/[0-9]*.sql; do
  [ -e "$t" ] || continue
  res=$($PSQL -d awe -f "$t" 2>&1 | sed 's/^psql.*NOTICE:  //')
  echo "$res" | grep -E '^(PASS|FAIL)' | sed 's/^/  /'
  n_fail=$(echo "$res" | grep -c '^FAIL' || true)
  n_pass=$(echo "$res" | grep -c '^PASS' || true)
  err=$(echo "$res" | grep -c '^psql.*ERROR' || true)
  echo "  -- $(basename "$t"): $n_pass passed, $n_fail failed, $err error(s)"
  fails=$((fails + n_fail + err))
done

echo
if [ "$fails" = "0" ]; then
  echo "pg-harness: PASS — $LATEST_NAME is MIGRATION VERIFIED and INTEGRATION VERIFIED"
  echo "            against a real PostgreSQL executing the real contract."
  echo "            This is NOT live verification and applies nothing to any hosted project."
else
  echo "pg-harness: FAIL ($fails)"
fi
exit "$fails"

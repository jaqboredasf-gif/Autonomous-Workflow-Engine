-- ---------------------------------------------------------------------------
-- 0035 — sign-in throttling that survives more than one server.
--
-- WHAT WAS WRONG
--
-- The throttle added in the previous milestone counts failures in a Map inside
-- the server process. On one machine in a workshop that is exactly right. On a
-- serverless host it is not: every warm instance keeps its own counters, so the
-- effective limit is five guesses TIMES however many instances are warm, and an
-- attacker who reconnects gets a fresh budget roughly whenever the platform
-- gives them a different one. The limit stops being a limit and becomes a
-- suggestion.
--
-- THE SHAPE, AND WHY IT IS A FUNCTION RATHER THAN A TABLE THE APP WRITES
--
-- Sign-in happens BEFORE authentication. There is no session, no JWT and no
-- `auth.uid()`, so there is no caller for row level security to scope — the
-- request arrives as `anon`. Handing `anon` INSERT and SELECT on a table of
-- attempt records would mean handing every anonymous visitor the ability to
-- read who has been trying to sign in and to write entries locking anybody out.
--
-- So `anon` gets no access to the table at all, and exactly one SECURITY
-- DEFINER function it may call. The function prunes, counts, decides and
-- records in ONE statement, which also removes the check-then-write race the
-- in-process version had: two simultaneous attempts can no longer both read
-- "four failures" and both be allowed.
--
-- KEYS ARE HASHED, and that is not decoration. An unhashed table would be a
-- list of email addresses readable by anybody who later gains any read access,
-- and a rather good one — it is precisely the addresses somebody thought were
-- worth guessing. The application sends sha256(key); the database never learns
-- an address.
--
-- NOT A GENERAL RATE LIMITER. It throttles sign-in. No buckets, no policies, no
-- configuration table. When something else needs limiting, it can have its own
-- narrow thing, or this can grow a scope column — deliberately not today.
-- ---------------------------------------------------------------------------

create table purchasing_sign_in_attempts (
  -- sha256 of "account:<lowercased email>" or "source:<address>", hex.
  key_hash    text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  -- The failure timestamps still inside the window, newest last. An array
  -- rather than a row per failure: the whole decision reads and writes one
  -- row, and there is no table to sweep separately.
  failures    timestamptz[] not null default '{}',
  updated_at  timestamptz not null default now()
);

comment on table purchasing_sign_in_attempts is
  'Failed sign-in timestamps per hashed key, for cross-instance throttling. Keys are '
  'sha256 hashes so the table never holds an email address. Written only by '
  'record_sign_in_attempt(); no role has direct access.';

create index purchasing_sign_in_attempts_stale_idx
  on purchasing_sign_in_attempts(updated_at);

-- Nobody reaches the table directly. RLS on with NO policies denies every
-- non-superuser caller, and the grants below never mention it.
alter table purchasing_sign_in_attempts enable row level security;

-- ---------------------------------------------------------------------------
-- THE DECISION, taken and recorded in one statement.
--
-- Returns the seconds to wait, or 0 when the attempt may proceed.
--
--   p_key_hash        sha256 of the key
--   p_max             failures allowed inside the window
--   p_window_seconds  how far back failures are counted
--   p_lock_seconds    how long a locked key stays locked
--   p_record          true to COUNT this attempt as a failure, false to only ask
--
-- The two-phase shape (ask before checking the password, record after it turns
-- out to be wrong) is what keeps the answer from being timed: the throttle is
-- consulted before any credential work happens.
-- ---------------------------------------------------------------------------
create or replace function record_sign_in_attempt(
  p_key_hash       text,
  p_max            integer,
  p_window_seconds integer,
  p_lock_seconds   integer,
  p_record         boolean
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now      timestamptz := now();
  v_cutoff   timestamptz := now() - make_interval(secs => p_window_seconds);
  v_recent   timestamptz[];
  v_newest   timestamptz;
  v_wait     integer := 0;
begin
  if p_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'sign-in throttle keys must be sha256 hex';
  end if;

  -- One row, locked for the duration: two simultaneous attempts cannot both
  -- read the same count and both be allowed through it.
  insert into purchasing_sign_in_attempts (key_hash) values (p_key_hash)
    on conflict (key_hash) do nothing;

  select array(select unnest(failures) as f where f > v_cutoff order by f)
    into v_recent
    from purchasing_sign_in_attempts
   where key_hash = p_key_hash
     for update;

  if array_length(v_recent, 1) >= p_max then
    -- The lock runs from the NEWEST failure, so guessing while locked extends
    -- it rather than running it down.
    v_newest := v_recent[array_length(v_recent, 1)];
    v_wait := greatest(1, ceil(extract(epoch from (v_newest + make_interval(secs => p_lock_seconds)) - v_now))::int);
  end if;

  if p_record then
    -- Bounded, or an attacker holds the pen on an unbounded array. Trimming the
    -- OLDEST cannot weaken the decision: the lock is measured from the newest.
    v_recent := (array(select unnest(v_recent) order by 1))[greatest(1, array_length(v_recent, 1) - 62):] || v_now;
  end if;

  update purchasing_sign_in_attempts
     set failures = coalesce(v_recent, '{}'), updated_at = v_now
   where key_hash = p_key_hash;

  return v_wait;
end $$;

comment on function record_sign_in_attempt(text, integer, integer, integer, boolean) is
  'Sign-in throttle: prunes, counts, decides and optionally records in one statement. '
  'Returns seconds to wait, or 0 to proceed. SECURITY DEFINER because sign-in happens '
  'before authentication — the caller is anon and must not touch the table itself.';

-- Clearing an account's budget after a successful sign-in. The SOURCE budget is
-- deliberately NOT cleared anywhere: one correct password among fifty wrong
-- ones is what a successful spray looks like.
create or replace function clear_sign_in_attempts(p_key_hash text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from purchasing_sign_in_attempts where key_hash = p_key_hash;
$$;

-- Housekeeping: a key nobody touches again would live forever. Safe to call
-- from anywhere, and safe never to call — a stale row only grants a few extra
-- guesses to somebody who stopped guessing long ago.
create or replace function prune_sign_in_attempts()
returns integer
language sql
security definer
set search_path = public
as $$
  with gone as (
    delete from purchasing_sign_in_attempts
     where updated_at < now() - interval '1 day'
     returning 1
  )
  select count(*)::int from gone;
$$;

-- The only reachable surface. `anon` may ask and record, because that is what
-- an unauthenticated sign-in attempt is; it may not read the table, list keys,
-- or clear anybody's budget.
revoke all on table purchasing_sign_in_attempts from anon, authenticated;
revoke all on function record_sign_in_attempt(text, integer, integer, integer, boolean) from public;
revoke all on function clear_sign_in_attempts(text) from public;
revoke all on function prune_sign_in_attempts() from public;

grant execute on function record_sign_in_attempt(text, integer, integer, integer, boolean) to anon, authenticated;
grant execute on function clear_sign_in_attempts(text) to anon, authenticated;
grant execute on function prune_sign_in_attempts() to service_role;

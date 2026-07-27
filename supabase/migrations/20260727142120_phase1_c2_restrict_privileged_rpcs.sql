-- C2: public functions are not APIs unless their exact signature is approved.
--
-- Preconditions:
--   * the migration executor owns every application function in public;
--   * the executor is therefore also the role whose default ACL is changed.
-- ALTER DEFAULT PRIVILEGES is owner-specific. Fail before changing ACLs if the
-- executor is not the function owner; do not create a false fail-closed claim.

do $$
declare
  not_owned text;
begin
  select string_agg(
           format('%I.%I(%s)', n.nspname, p.proname,
                  pg_get_function_identity_arguments(p.oid)),
           ', ' order by p.proname, pg_get_function_identity_arguments(p.oid)
         )
    into not_owned
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prokind = 'f'
    and p.proowner <> (select oid from pg_roles where rolname = current_user);

  if not_owned is not null then
    raise exception
      'C2 precondition failed: executor % does not own public functions: %',
      current_user, not_owned;
  end if;
end
$$;

-- set_geo_flags() is invoked by the time_entries trigger and calls the internal
-- haversine_m() helper. Run that trigger as its owner so the helper does not
-- need authenticated EXECUTE and become a client RPC. The public schema must
-- remain non-writable by API roles; the postcondition below verifies that.
alter function public.set_geo_flags()
  security definer
  set search_path = pg_catalog, public;

-- Revoke by exact catalog identity so overloads cannot inherit an approved
-- name. Trigger functions are included and are not re-granted to API roles.
do $$
declare
  fn record;
begin
  for fn in
    select format('%I.%I(%s)', n.nspname, p.proname,
                  pg_get_function_identity_arguments(p.oid)) as identity
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
    order by p.oid
  loop
    execute format(
      'revoke execute on function %s from public, anon, authenticated, service_role',
      fn.identity
    );
  end loop;
end
$$;

-- Client-executable RLS helpers. These are not application RPCs.
grant execute on function public.current_org_id()
  to anon, authenticated, service_role;
grant execute on function public.current_role_is(user_role)
  to anon, authenticated, service_role;

-- Exact authenticated application RPC surface verified from shipped call sites.
grant execute on function public.business_role_matches(uuid, business_role)
  to authenticated, service_role;
grant execute on function public.record_approval(uuid, text, text)
  to authenticated, service_role;

-- Explicit internal/service-role entry points. These are not client RPCs.
grant execute on function public.apply_timecard_correction(uuid)
  to service_role;
grant execute on function public.mark_message_sent(uuid)
  to service_role;
grant execute on function public.check_territory(uuid, text, text)
  to service_role;
grant execute on function public.is_emergency_text(text)
  to service_role;
grant execute on function public.route_outbound(
  uuid, outbound_message_type, bigint, business_role[]
) to service_role;
grant execute on function public.create_outbound_draft(
  uuid, uuid, outbound_message_type, text, text, text, text[], bigint,
  business_role[], boolean, jsonb
) to service_role;

-- Future functions created by this same owner must opt into execution.
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated, service_role;

do $$
declare
  fn record;
  expected boolean;
  default_execute_leak boolean;
  api_can_create_public boolean;
begin
  select has_schema_privilege('anon', 'public', 'CREATE')
      or has_schema_privilege('authenticated', 'public', 'CREATE')
      or has_schema_privilege('service_role', 'public', 'CREATE')
    into api_can_create_public;

  if api_can_create_public then
    raise exception
      'C2 failed: an API role can CREATE in public; fixed search_path is unsafe';
  end if;

  for fn in
    select p.oid,
           p.prorettype = 'trigger'::regtype as is_trigger,
           format('%I.%I(%s)', n.nspname, p.proname,
                  oidvectortypes(p.proargtypes)) as identity
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
  loop
    expected := fn.identity in (
      'public.current_org_id()',
      'public.current_role_is(user_role)'
    );
    if has_function_privilege('anon', fn.oid, 'EXECUTE') is distinct from expected then
      raise exception 'C2 failed: anon execute mismatch for %', fn.identity;
    end if;

    expected := fn.identity in (
      'public.current_org_id()',
      'public.current_role_is(user_role)',
      'public.business_role_matches(uuid, business_role)',
      'public.record_approval(uuid, text, text)'
    );
    if has_function_privilege('authenticated', fn.oid, 'EXECUTE') is distinct from expected then
      raise exception 'C2 failed: authenticated execute mismatch for %', fn.identity;
    end if;

    expected := fn.identity in (
      'public.current_org_id()',
      'public.current_role_is(user_role)',
      'public.business_role_matches(uuid, business_role)',
      'public.record_approval(uuid, text, text)',
      'public.apply_timecard_correction(uuid)',
      'public.mark_message_sent(uuid)',
      'public.check_territory(uuid, text, text)',
      'public.is_emergency_text(text)',
      'public.route_outbound(uuid, outbound_message_type, bigint, business_role[])',
      'public.create_outbound_draft(uuid, uuid, outbound_message_type, text, text, text, text[], bigint, business_role[], boolean, jsonb)'
    );
    if has_function_privilege('service_role', fn.oid, 'EXECUTE') is distinct from expected then
      raise exception 'C2 failed: service_role execute mismatch for %', fn.identity;
    end if;

    if exists (
      select 1
      from aclexplode(coalesce((select proacl from pg_proc where oid = fn.oid),
                               acldefault('f', (select proowner from pg_proc where oid = fn.oid)))) acl
      where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
    ) then
      raise exception 'C2 failed: PUBLIC retains execute on %', fn.identity;
    end if;

    if fn.is_trigger and (
      has_function_privilege('anon', fn.oid, 'EXECUTE')
      or has_function_privilege('authenticated', fn.oid, 'EXECUTE')
      or has_function_privilege('service_role', fn.oid, 'EXECUTE')
    ) then
      raise exception 'C2 failed: trigger function remains directly exposed: %',
        fn.identity;
    end if;
  end loop;

  select exists (
    select 1
    from pg_default_acl d
    cross join lateral aclexplode(d.defaclacl) acl
    join pg_namespace n on n.oid = d.defaclnamespace
    where d.defaclrole = (select oid from pg_roles where rolname = current_user)
      and n.nspname = 'public'
      and d.defaclobjtype = 'f'
      and acl.grantee in (
        0,
        (select oid from pg_roles where rolname = 'anon'),
        (select oid from pg_roles where rolname = 'authenticated'),
        (select oid from pg_roles where rolname = 'service_role')
      )
      and acl.privilege_type = 'EXECUTE'
  ) into default_execute_leak;

  if default_execute_leak then
    raise exception
      'C2 failed: executor % still grants default API function execution',
      current_user;
  end if;
end
$$;

-- C2: public functions are not APIs unless explicitly granted below.

revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;

-- RLS helpers are intentionally callable by client roles. Anonymous calls
-- return NULL/FALSE and preserve fail-closed RLS behavior.
grant execute on function public.current_org_id() to anon, authenticated;
grant execute on function public.current_role_is(user_role) to anon, authenticated;

-- Intentional authenticated-human RPC surface.
grant execute on function public.business_role_matches(uuid, business_role)
  to authenticated;
grant execute on function public.record_approval(uuid, text, text)
  to authenticated;
grant execute on function public.apply_timecard_correction(uuid)
  to authenticated;
grant execute on function public.mark_message_sent(uuid)
  to authenticated;

-- Future functions must opt into client execution explicitly.
alter default privileges in schema public
  revoke execute on functions from public;

do $$
declare
  leaked integer;
begin
  select count(*) into leaked
  from information_schema.routine_privileges
  where specific_schema = 'public'
    and grantee in ('PUBLIC', 'anon', 'authenticated')
    and privilege_type = 'EXECUTE'
    and routine_name not in (
      'current_org_id',
      'current_role_is',
      'business_role_matches',
      'record_approval',
      'apply_timecard_correction',
      'mark_message_sent'
    );

  if leaked <> 0 then
    raise exception 'C2 failed: % unintended client function grants remain', leaked;
  end if;
end
$$;

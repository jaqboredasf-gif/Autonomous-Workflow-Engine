-- C4: MCP startup must prove its deployment-bound tenant exists.

create or replace function public.assert_mcp_tenant(p_org_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_org_id is null then
    raise exception 'MCP tenant is required';
  end if;
  if not exists (select 1 from public.orgs where id = p_org_id) then
    raise exception 'MCP tenant does not exist';
  end if;
  return p_org_id;
end
$$;

revoke execute on function public.assert_mcp_tenant(uuid)
  from public, anon, authenticated;
grant execute on function public.assert_mcp_tenant(uuid) to service_role;

do $$
begin
  if has_function_privilege('anon', 'public.assert_mcp_tenant(uuid)', 'EXECUTE')
     or has_function_privilege(
       'authenticated', 'public.assert_mcp_tenant(uuid)', 'EXECUTE'
     ) then
    raise exception 'C4 failed: MCP tenant assertion is client executable';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 0021 — who may create an organization.
--
-- provision_organization() is SECURITY DEFINER: it writes an org, its first
-- administrator, that person's membership and their ADMIN role in one
-- transaction. Whoever can execute it can mint a tenant and make themselves its
-- administrator.
--
-- So it is NOT granted to `authenticated`. Signing up is not the same act as
-- creating a tenant, and an ordinary signed-in user of one organization has no
-- business creating another. It is granted to `service_role` only, which means
-- it can be called from a server-side signup path the operator controls, and
-- never from a browser holding a user's token.
--
-- Found by running the local stack: without this, provisioning failed with
-- "permission denied for function provision_organization" — the function
-- existed and was correct, and was simply unreachable.
-- ---------------------------------------------------------------------------

revoke execute on function provision_organization(text, uuid, text, text, text, bigint) from public;
revoke execute on function provision_organization(text, uuid, text, text, text, bigint) from anon;
revoke execute on function provision_organization(text, uuid, text, text, text, bigint) from authenticated;
grant  execute on function provision_organization(text, uuid, text, text, text, bigint) to service_role;

-- The invitation acceptance path stays with `authenticated`: an invited person
-- IS signed in when they accept, and the function checks the invitation token
-- rather than trusting the caller. Restated here so the two decisions sit
-- together and the contrast is visible.
grant execute on function accept_purchasing_invitation(uuid) to authenticated;

-- service_role must also be able to reach the tables it seeds during
-- provisioning. It bypasses RLS, but a missing GRANT still blocks it.
do $$
declare t text;
begin
  foreach t in array array[
    'orgs', 'purchasing_org_memberships', 'purchasing_invitations',
    'users', 'purchasing_user_roles', 'purchase_vendors', 'purchase_jobs',
    'purchase_delivery_locations', 'purchasing_settings'
  ] loop
    execute format('grant select, insert, update on public.%I to service_role', t);
  end loop;
end $$;

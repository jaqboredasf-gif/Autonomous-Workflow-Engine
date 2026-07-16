-- Crew clock-out: foremen close entries for their crew (flag-review edits
-- stay admin-only via status guard — approved/locked rows untouchable here).

create policy te_foreman_update on time_entries
  for update using (
    org_id = current_org_id()
    and current_role_is('foreman')
    and status in ('open', 'submitted')
  );

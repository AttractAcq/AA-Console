-- ============================================================
-- AA Console · 19 · Employees get job scope, not whole-client scope
--
-- can_access_client() is one broad grant: an employee assigned to a job
-- reaches everything belonging to that client. That is more than the
-- Employee console renders — it means an editor could read the client's
-- current and target revenue out of client_business_context.
--
-- Employees keep what their console actually uses: the client's name, the
-- briefs attached to their jobs, and their own uploads. The commercial and
-- strategic tables narrow to admin plus that client's own users.
-- ============================================================

create or replace function is_client_user(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from client_users cu
     where cu.user_id = auth.uid() and cu.client_id = target
  );
$$;
revoke execute on function is_client_user(uuid) from anon, public;
grant execute on function is_client_user(uuid) to authenticated;

-- ---------- business context: revenue lives here ----------
drop policy if exists cbc_scoped_read on client_business_context;
create policy cbc_client_read on client_business_context
  for select to authenticated using (is_client_user(client_id));

-- ---------- proof ----------
drop policy if exists cpa_scoped_read on client_proof_assets;
drop policy if exists cpa_client_insert on client_proof_assets;
create policy cpa_client_read on client_proof_assets
  for select to authenticated using (is_client_user(client_id));
create policy cpa_client_insert on client_proof_assets
  for insert to authenticated with check (is_client_user(client_id));

-- ---------- strategy and pipeline surfaces ----------
drop policy if exists ci_scoped_read on client_ideas;
create policy ci_client_read on client_ideas
  for select to authenticated using (is_client_user(client_id));

drop policy if exists cp_scoped_read on client_pages;
create policy cp_client_read on client_pages
  for select to authenticated using (is_client_user(client_id));

drop policy if exists cl_scoped_read on client_leads;
create policy cl_client_read on client_leads
  for select to authenticated using (is_client_user(client_id));

drop policy if exists car_scoped_read on client_agent_records;
create policy car_client_read on client_agent_records
  for select to authenticated using (is_client_user(client_id));

drop policy if exists cai_scoped_read on client_agent_inputs;
create policy cai_client_read on client_agent_inputs
  for select to authenticated using (is_client_user(client_id));

drop policy if exists cars_scoped_read on client_asset_reviews;
create policy cars_client_read on client_asset_reviews
  for select to authenticated
  using (exists (select 1 from client_media_assets a
                  where a.id = asset_id and is_client_user(a.client_id)));

-- client_briefs deliberately keeps can_access_client: an assignee has to
-- be able to open the brief attached to their job.;

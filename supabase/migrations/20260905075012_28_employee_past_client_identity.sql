-- ============================================================
-- AA Console · 28 · Past clients stay legible to the employee who worked them
--
-- can_access_client() deliberately drops an employee's access when their
-- assignment ends (ca.ended_at is null). That is correct for the client's
-- data — an ex-assignee must not keep reading their business context,
-- media or proof.
--
-- But it also hides the client's NAME, which makes a "Past Clients" page
-- impossible: the assignment rows are readable, the client they point at
-- is not, so the page renders a list of blanks.
--
-- This grants identity only, and only to the person who actually did the
-- work. Everything genuinely sensitive is already scoped to
-- is_client_user() by migration 19, so this does not widen access to any
-- client data — only to the fact that this employee once worked for them.
-- ============================================================

create policy clients_former_assignee_read on clients
  for select to authenticated
  using (
    exists (
      select 1
        from client_assignments ca
        join team_members tm on tm.id = ca.member_id
       where tm.user_id = auth.uid()
         and ca.client_id = clients.id
         and ca.ended_at is not null
    )
  );

comment on policy clients_former_assignee_read on clients is
  'Lets an employee see the identity of clients they used to be assigned to, so their own work history is legible. Does not restore access to that client''s data.';;

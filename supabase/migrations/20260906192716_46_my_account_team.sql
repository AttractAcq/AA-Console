-- "Who is on my account" for the client console.
--
-- A client cannot read team_members, and should not: it carries contact
-- details, engagement terms and personal notes. But knowing who is doing
-- your work is the most basic thing an account page owes you.
--
-- So this returns the two fields that answer the question and nothing else —
-- no email, no contact_info, no engagement, no id — for the people currently
-- assigned to the caller's own client. It is scoped by auth.uid() through
-- client_users, so it cannot be pointed at another client.

create or replace function my_account_team()
returns table (name text, category text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select tm.name, tm.category::text
    from client_assignments ca
    join team_members tm on tm.id = ca.member_id
   where ca.ended_at is null
     and tm.active = true
     and ca.client_id in (
       select cu.client_id from client_users cu where cu.user_id = auth.uid()
     )
   order by tm.category, tm.name;
$$;

revoke execute on function my_account_team() from public, anon;
grant execute on function my_account_team() to authenticated;

comment on function my_account_team() is
  'Names and roles of the team assigned to the calling client. Deliberately returns nothing else — clients cannot read team_members.';;

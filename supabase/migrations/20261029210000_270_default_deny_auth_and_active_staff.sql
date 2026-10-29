-- 270 · Auth users have no console access until trusted provisioning links them.
-- Migration 263 stopped editable metadata from choosing a privileged role, but
-- the fallback employee profile could still be a member of a chat channel
-- without a live team record. Migration 266 separately closes the analogous
-- SOP metadata/storage path. The Auth insert trigger must not grant even that
-- baseline role. create_console_user() explicitly
-- inserts the intended profile after the Auth insert fires this trigger.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Migration 16 replaced role-only chat policies with channel membership.
-- Keep that narrower boundary. Migration 127's current_member_id() returns
-- an ID only for active staff; client and admin channel members remain valid.
create or replace function public.is_channel_member(target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.channel_members m
      join public.profiles p on p.id = m.user_id
     where m.channel_id = target
       and m.user_id = auth.uid()
       and (
         p.role <> 'employee'::public.app_role
         or public.current_member_id() is not null
       )
  );
$$;

revoke execute on function public.is_channel_member(uuid) from public, anon;
grant execute on function public.is_channel_member(uuid) to authenticated, service_role;

-- The name-only chat helper bypasses RLS and previously used raw membership.
-- Require the same live membership as message and channel policies.
create or replace function public.chat_participants()
returns table (id uuid, display_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct
         p.id,
         coalesce(nullif(btrim(p.full_name), ''), split_part(p.email, '@', 1)) as display_name
    from public.channel_members mine
    join public.channel_members theirs on theirs.channel_id = mine.channel_id
    join public.profiles p on p.id = theirs.user_id
   where mine.user_id = auth.uid()
     and public.is_channel_member(mine.channel_id);
$$;

revoke execute on function public.chat_participants() from public, anon;
grant execute on function public.chat_participants() to authenticated;

-- Migration 16 retained an author-only UPDATE policy from migration 08.
-- An inactive or unlinked employee must not edit messages after losing chat.
drop policy if exists tmsg_self_update on public.team_messages;
create policy tmsg_self_update on public.team_messages
  for update to authenticated
  using (author_id = auth.uid() and public.is_channel_member(channel_id))
  with check (author_id = auth.uid() and public.is_channel_member(channel_id));

-- Do not reveal even a former member's channel IDs after access is revoked.
drop policy if exists cm_self_read on public.channel_members;
create policy cm_self_read on public.channel_members
  for select to authenticated
  using (user_id = auth.uid() and public.is_channel_member(channel_id));

-- Current employee and client account pages are read-only. The old self
-- update policies allowed direct API callers to change employee_category,
-- active, category, and other authority-bearing fields. Admin policies and
-- trusted SECURITY DEFINER provisioning/name-sync functions retain writes.
drop policy if exists profiles_self_update on public.profiles;
drop policy if exists team_members_self_update on public.team_members;

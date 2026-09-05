-- ============================================================
-- AA Console · 16 · Channel membership + live chat
--
-- A channel is only visible to the people an admin has added to it, so
-- the dev_open_read policy is dropped on the three chat tables — leaving
-- it would show every channel to everyone and defeat the feature.
-- ============================================================

create table channel_members (
  channel_id uuid not null references team_channels(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  added_by   uuid references profiles(id) on delete set null,
  added_at   timestamptz not null default now(),
  primary key (channel_id, user_id)
);
create index cm_user_idx on channel_members (user_id);

-- SECURITY DEFINER so the channel policies can use it without recursing
-- through the very policies being evaluated.
create or replace function is_channel_member(target uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from channel_members m
     where m.channel_id = target and m.user_id = auth.uid()
  );
$$;

-- ---------- rescope the chat tables ----------
drop policy if exists dev_open_read on team_channels;
drop policy if exists dev_open_read on team_messages;
drop policy if exists tc_staff_read on team_channels;
drop policy if exists tmsg_staff_read on team_messages;
drop policy if exists tmsg_staff_insert on team_messages;

-- Channels: admins manage everything; everyone else sees only theirs.
create policy tc_member_read on team_channels
  for select to authenticated using (is_channel_member(id));

-- Messages: readable and writable by the channel's members.
create policy tmsg_member_read on team_messages
  for select to authenticated
  using (is_admin() or is_channel_member(channel_id));
create policy tmsg_member_insert on team_messages
  for insert to authenticated
  with check (author_id = auth.uid() and (is_admin() or is_channel_member(channel_id)));

alter table channel_members enable row level security;
create policy cm_admin_all on channel_members
  for all to authenticated using (is_admin()) with check (is_admin());
create policy cm_self_read on channel_members
  for select to authenticated using (user_id = auth.uid());
-- members can see who else is in a channel they belong to
create policy cm_peer_read on channel_members
  for select to authenticated using (is_channel_member(channel_id));

-- ---------- realtime ----------
alter publication supabase_realtime add table channel_members;

-- ---------- everyone who exists today gets the general channel ----------
do $$
declare v_general uuid;
begin
  select id into v_general from team_channels where name = 'general' limit 1;
  if v_general is null then
    insert into team_channels (name) values ('general') returning id into v_general;
  end if;

  insert into channel_members (channel_id, user_id)
  select v_general, p.id from profiles p
  on conflict do nothing;
end $$;;

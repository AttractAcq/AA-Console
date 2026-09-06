-- Chat needs a name to put on a message. It was getting the whole profile.
--
-- profiles_channel_peer_read granted read of every column — email, role,
-- timestamps — to anyone sharing a channel. Two consequences: a client could
-- read staff email addresses, and two clients in one channel could read each
-- other's profile. Nothing else crossed over, but that was the one path by
-- which two clients could see anything of each other's.
--
-- Column privileges cannot fix this: they are role-wide, so revoking email
-- from authenticated would blind admins too. So the row access goes, and the
-- one field chat actually needs comes from a function instead.
--
-- display_name falls back to the local part of the address rather than the
-- address itself: a name to show, not a way to contact someone.

create or replace function chat_participants()
returns table (id uuid, display_name text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select distinct
         p.id,
         coalesce(nullif(btrim(p.full_name), ''), split_part(p.email, '@', 1)) as display_name
    from channel_members mine
    join channel_members theirs on theirs.channel_id = mine.channel_id
    join profiles p on p.id = theirs.user_id
   where mine.user_id = auth.uid();
$$;

revoke execute on function chat_participants() from public, anon;
grant execute on function chat_participants() to authenticated;

comment on function chat_participants() is
  'Id and display name of everyone sharing a channel with the caller. Deliberately returns nothing else - it replaces read access to profiles.';

-- The policy this replaces.
drop policy profiles_channel_peer_read on profiles;;

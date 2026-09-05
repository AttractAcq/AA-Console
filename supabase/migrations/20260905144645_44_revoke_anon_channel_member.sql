-- is_channel_member is an RLS helper. It was the only SECURITY DEFINER
-- function still reachable without signing in, which migration 10 revoked
-- for every other one.
--
-- Exposure was small — anon has no auth.uid(), so it returned false — but a
-- function that exists to answer "is the current user in this channel"
-- should not be callable by someone who is not a user.
revoke execute on function is_channel_member(uuid) from anon;

comment on function is_channel_member(uuid) is
  'RLS helper: is the calling user a member of this channel. authenticated and service_role only.';;

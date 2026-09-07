-- The Master AI had no spend ceiling.
--
-- Per-turn cost was recorded in master_ai_messages.cost_usd and never
-- totalled, so nothing anywhere knew what the chat had cost today. A turn
-- runs up to twelve model calls at $0.06-$0.16 each, and an admin asking a
-- broad question in a loop is an unbounded bill with no signal until it
-- arrives.
--
-- This is the total. The runtime enforces the limits against it and the
-- console shows the same number, so what is displayed and what is enforced
-- cannot drift apart.

create or replace function public.master_ai_spend(p_conversation_id uuid default null)
returns table (day_usd numeric, conversation_usd numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- The runtime calls this as service_role, which has no auth.uid(); the
  -- console calls it as an admin. Anyone else has no business reading it.
  if auth.role() <> 'service_role' and not is_admin() then
    raise exception 'Only an admin may read Master AI spend.' using errcode = '42501';
  end if;

  return query
  select
    -- Explicitly UTC midnight rather than date_trunc on a bare now(): the
    -- window a ceiling resets on must not depend on the server's timezone.
    coalesce((
      select sum(m.cost_usd)
      from master_ai_messages m
      where m.created_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')
    ), 0)::numeric,
    coalesce((
      select sum(m.cost_usd)
      from master_ai_messages m
      where p_conversation_id is not null
        and m.conversation_id = p_conversation_id
    ), 0)::numeric;
end;
$$;

-- Functions grant EXECUTE to PUBLIC by default and anon inherits it, so
-- revoking from anon alone is a silent no-op. Revoke from PUBLIC, then
-- grant back explicitly.
revoke execute on function public.master_ai_spend(uuid) from public, anon;
grant  execute on function public.master_ai_spend(uuid) to authenticated, service_role;

comment on function public.master_ai_spend(uuid) is
  'Master AI spend: today so far (UTC day) and, optionally, one conversation. Admin or service_role only. The single source of truth for both the runtime ceiling and the console budget line.';

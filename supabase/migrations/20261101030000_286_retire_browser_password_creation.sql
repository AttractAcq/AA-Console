-- B004: retire the browser-supplied password path before controlled invitations.
-- Keep the existing six-argument RPC signature for old clients so they fail
-- closed; login provisioning will use a separately approved Auth invitation.
create or replace function public.admin_create_team_member(
  p_name       text,
  p_initials   text,
  p_category   public.team_category,
  p_engagement public.engagement_type default 'contractor',
  p_username   text default null,
  p_password   text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member uuid;
begin
  if not public.is_admin() then
    raise exception 'Admins only' using errcode = '42501';
  end if;

  -- Do not inspect, persist, hash, or echo either supplied credential. RAISE
  -- LOG is outside the aborted transaction and contains only the actor ID.
  if p_username is not null or p_password is not null then
    raise log 'admin_create_team_member legacy login attempt rejected; actor=%', auth.uid();
    raise exception 'Login creation requires an approved invitation' using errcode = '42501';
  end if;

  insert into public.team_members (user_id, category, name, initials, engagement)
  values (null, p_category, p_name, p_initials, p_engagement)
  returning id into v_member;

  return v_member;
end;
$$;

revoke execute on function public.admin_create_team_member(
  text, text, public.team_category, public.engagement_type, text, text
) from public, anon;
grant execute on function public.admin_create_team_member(
  text, text, public.team_category, public.engagement_type, text, text
) to authenticated;

comment on function public.admin_create_team_member(
  text, text, public.team_category, public.engagement_type, text, text
) is 'Roster-only legacy signature. Rejects every browser credential argument; login uses approved Auth invitations.';

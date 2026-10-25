-- G12: who decides a piece is good enough.
--
-- The gap was recorded as "no creative-director or SMM seat". Half of that
-- turned out to be wrong, and the correction is worth writing down because
-- it is the kind of thing a reader would otherwise rediscover.
--
-- The SMM seat exists and is load-bearing. `active_video_approval_manager`
-- resolves to the SMM assigned to the client -- `tm.category = 'smm'` -- and
-- forty-three functions gate on it: proof, placements, motion, pages,
-- campaign actions. It is the universal "assigned approver for this client".
-- Its name says video because video is what it was written for, and it has
-- been quietly reused for everything since. The name is not changed here;
-- forty-three dependents is not a rename, it is a project.
--
-- What is genuinely missing is two things.
--
-- A CREATIVE DIRECTOR HAS NOWHERE TO SIT
--
-- `team_category` is avatars, editors and smm. "Creative director" exists in
-- this system only as a string inside two prompts -- one that generates
-- creative and one that screens it -- so the person who actually owns whether
-- work is on-brand cannot be named, assigned or recorded.
--
-- NOBODY RECORDS WHICH SEAT A DECISION WAS MADE FROM
--
-- `review_media_asset` gates non-video assets on `can_access_client` alone.
-- Anybody on the client can approve creative, and the review row says who
-- but not in what capacity. So "who decides a piece is on-brand" is a
-- convention in somebody's team, not a fact in the console -- which is the
-- gap as written.
--
-- WHY THIS DOES NOT WIDEN OR NARROW ANYBODY'S PERMISSIONS BY DEFAULT
--
-- Changing who may approve creative, across a web of forty-three functions
-- that share one resolver, is the sort of migration that breaks a client's
-- Friday. So the seat is recorded rather than enforced, and enforcement is
-- opt-in per client via `creative_director_required`. Off, nothing changes.
-- On, an approval must come from the creative director or an admin, and the
-- refusal says who to go to by name.

-- The new value cannot be used in the same transaction that adds it, so every
-- comparison below is against `category::text`. Migration 90 learned this.
alter type team_category add value if not exists 'creative_director';

comment on type team_category is
  'The kinds of people assigned to a client. smm is also the universal approver that active_video_approval_manager resolves to, despite that function''s name. creative_director owns whether creative is on-brand.';

-- ---------------------------------------------------------------------------
-- The resolver, mirroring the SMM one exactly
-- ---------------------------------------------------------------------------

create or replace function public.active_creative_director(p_client_id uuid)
returns uuid language sql stable security definer
set search_path = pg_catalog, public as $$
  select tm.user_id from public.client_assignments ca
  join public.team_members tm on tm.id = ca.member_id
  where ca.client_id = p_client_id and ca.ended_at is null
    and tm.active and tm.category::text = 'creative_director' and tm.user_id is not null
  order by ca.created_at desc, ca.id desc limit 1;
$$;

comment on function public.active_creative_director(uuid) is
  'The creative director currently assigned to a client, or null. Mirrors active_video_approval_manager, which resolves to the assigned SMM.';

revoke all on function public.active_creative_director(uuid) from public, anon;
grant execute on function public.active_creative_director(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Opt-in enforcement
-- ---------------------------------------------------------------------------

alter table public.client_engine_settings
  add column if not exists creative_director_required boolean not null default false;

comment on column public.client_engine_settings.creative_director_required is
  'When on, approving creative for this client requires the assigned creative director or an admin. Off by default: turning it on is a change to who may approve, and that belongs to whoever runs the client rather than to a migration.';

-- ---------------------------------------------------------------------------
-- Who holds which seat, said plainly
-- ---------------------------------------------------------------------------

drop view if exists client_creative_authority;

create view client_creative_authority with (security_invoker = true) as
select
  c.id as client_id,
  c.name as client_name,
  public.active_video_approval_manager(c.id) as smm_user_id,
  public.active_creative_director(c.id) as creative_director_user_id,
  coalesce(s.creative_director_required, false) as creative_director_required,
  case
    when public.active_video_approval_manager(c.id) is null
      then 'No SMM is assigned, so nothing that needs an assigned approver can be decided for this client.'
    when coalesce(s.creative_director_required, false)
         and public.active_creative_director(c.id) is null
      then 'Creative director sign-off is required for this client and nobody holds the seat, so no creative can be approved.'
    when public.active_creative_director(c.id) is null
      then 'No creative director is assigned. Creative is approved by whoever has access, and the seat each decision was made from is recorded.'
    else null
  end as problem
from public.clients c
left join public.client_engine_settings s on s.client_id = c.id;

comment on view client_creative_authority is
  'Per client: who the assigned SMM is, who the creative director is, and whether creative director sign-off is required. The SMM is also what active_video_approval_manager returns, which its name does not say.';

grant select on client_creative_authority to authenticated;

-- ---------------------------------------------------------------------------
-- The seat a decision was made from
-- ---------------------------------------------------------------------------

alter table public.client_asset_reviews
  add column if not exists decided_in_seat text
    check (decided_in_seat is null or decided_in_seat in
      ('admin', 'creative_director', 'smm', 'client', 'other'));

comment on column public.client_asset_reviews.decided_in_seat is
  'Which capacity the decision was made in, resolved at the moment of the decision. Recorded rather than inferred later, because assignments end and a review read in six months must still say who was responsible then.';

create or replace function public.creative_seat_of(p_client_id uuid, p_user_id uuid)
returns text language sql stable security definer
set search_path = pg_catalog, public as $$
  select case
    when p_user_id is null then 'other'
    when coalesce(public.is_admin(), false) then 'admin'
    when p_user_id = public.active_creative_director(p_client_id) then 'creative_director'
    when p_user_id = public.active_video_approval_manager(p_client_id) then 'smm'
    when exists (select 1 from public.client_users cu
                  where cu.client_id = p_client_id and cu.user_id = p_user_id) then 'client'
    else 'other'
  end;
$$;

comment on function public.creative_seat_of(uuid, uuid) is
  'Which seat a person occupies for a client right now. Admin wins, then creative director, then SMM: a person can hold more than one and the decision should record the most specific responsibility.';

revoke all on function public.creative_seat_of(uuid, uuid) from public, anon;
grant execute on function public.creative_seat_of(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The decision, now recording its seat
-- ---------------------------------------------------------------------------

-- Replaced in full rather than wrapped. Every existing refusal is kept
-- verbatim and in the same order, so the sentence a person already knows is
-- the sentence they still get; the two additions are the opt-in creative
-- director gate and the seat written onto the review row.
create or replace function public.review_media_asset(
  p_asset_id uuid, p_decision review_status, p_reason text default null)
returns void language plpgsql security definer
set search_path = public as $function$
declare
  a client_media_assets%rowtype;
  v_state jsonb;
  v_seat text;
  v_required boolean;
  v_director uuid;
begin
  select * into a from client_media_assets where id = p_asset_id for update;
  if a.id is null then raise exception 'Asset not found'; end if;
  if not can_access_client(a.client_id) then raise exception 'Not permitted for this client'; end if;
  if a.media_type = 'video' and a.human_approved_at is not null then
    raise exception 'This video version has already been finalized.';
  end if;
  if p_decision = 'pending' then raise exception 'Decision must be approved or rejected'; end if;
  if p_decision = 'approved' and a.edit_stage <> 'review_ready' then
    raise exception 'Edit the source footage before approving a finished video.';
  end if;
  if p_decision = 'approved' and a.content_format = 'reel'
     and nullif(btrim(a.render_path), '') is null then
    raise exception 'Finish the reel cut before approving it';
  end if;

  -- G12: the opt-in seat gate. Only on approval, and only where a client has
  -- asked for it -- a rejection should never be blocked, because refusing
  -- work is not an act that needs authority.
  if p_decision = 'approved' then
    select coalesce(creative_director_required, false) into v_required
      from client_engine_settings where client_id = a.client_id;
    if coalesce(v_required, false) then
      v_director := active_creative_director(a.client_id);
      if v_director is null then
        raise exception 'This client requires creative director sign-off and nobody holds that seat. Assign one before approving creative.';
      end if;
      if not coalesce(is_admin(), false) and auth.uid() is distinct from v_director then
        raise exception 'Only the assigned creative director or an admin can approve creative for this client.';
      end if;
    end if;
  end if;

  if p_decision = 'approved' and a.media_type = 'video' then
    v_state := video_approval_state(a.id);
    if (v_state->>'owner_user_id') is null then
      raise exception 'Configure an owner account before approving video.';
    end if;
    if (v_state->>'manager_user_id') is null then
      raise exception 'Assign an active SMM to this client before approving video.';
    end if;
    if auth.uid() is distinct from (v_state->>'owner_user_id')::uuid
       and auth.uid() is distinct from (v_state->>'manager_user_id')::uuid then
      raise exception 'Only the owner or active SMM can finalize video approval.';
    end if;
    if not coalesce((v_state->>'owner_approved')::boolean, false)
       or not coalesce((v_state->>'manager_approved')::boolean, false)
       or ((v_state->>'client_user_id') is not null
           and not coalesce((v_state->>'client_approved')::boolean, false)) then
      raise exception 'Wait for the owner, SMM and requested client sign-offs.';
    end if;
  end if;

  v_seat := creative_seat_of(a.client_id, auth.uid());

  update client_media_assets set review_status = p_decision,
    human_approved_at = case when p_decision = 'approved' then now() else null end
    where id = p_asset_id;
  insert into client_asset_reviews (asset_id, decision, reason, reviewed_by, decided_in_seat)
    values (p_asset_id, p_decision, p_reason, auth.uid(), v_seat);
end;
$function$;

comment on function public.review_media_asset(uuid, review_status, text) is
  'Records a creative decision and the seat it was made from. Enforces creative director sign-off only where a client has asked for it, and never blocks a rejection.';

-- ---------------------------------------------------------------------------
-- Who has been deciding
-- ---------------------------------------------------------------------------

drop view if exists creative_decisions;

create view creative_decisions with (security_invoker = true) as
select
  a.client_id,
  r.asset_id,
  a.title as asset_title,
  a.media_type,
  a.content_format,
  r.decision,
  r.reason,
  r.reviewed_by,
  coalesce(r.decided_in_seat, 'unrecorded') as seat,
  r.created_at as decided_at,
  -- Whether the person who decided still holds that seat. A decision is not
  -- wrong because somebody left, but a pattern of approvals from 'other' is
  -- worth seeing.
  -- Coalesced: once nobody holds the seat the resolver returns null, and an
  -- equality against null is null. A three-valued boolean in a column a
  -- person reads as yes-or-no is a bug.
  coalesce(r.decided_in_seat = 'creative_director'
     and r.reviewed_by = public.active_creative_director(a.client_id), false) as still_in_seat
from public.client_asset_reviews r
join public.client_media_assets a on a.id = r.asset_id;

comment on view creative_decisions is
  'Every creative decision with the seat it was made from. Rows reading "unrecorded" predate migration 247; "other" means somebody with client access who held no named seat, which is the pattern worth noticing.';

grant select on creative_decisions to authenticated;

select lock_down_definer_functions();

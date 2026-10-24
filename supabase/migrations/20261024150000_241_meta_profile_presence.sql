-- Meta Profile: whose account this is, and whether it still works.
--
-- v1 of this page reuses the organic post board and the organic metrics tab,
-- which means it answers neither question the page exists for. Is this
-- client's account actually connected? And does the profile hold up when
-- somebody who saw an ad lands on it?
--
-- The first is answerable today and nothing asks it. `client_integrations`
-- already carries the status, the token expiry and the health detail that
-- migration 157's token health check writes, and a disconnected account
-- currently shows up as an empty post board — indistinguishable from a client
-- with nothing scheduled.
--
-- The second needs the same shape Google Profile got: a proposed change with
-- its before and its after, waiting for a person. Not a patch. Somebody has
-- to see what the profile says today beside what we would make it say, and a
-- patch hides the first half.
--
-- WHAT THIS DOES NOT DO
--
-- It changes no profile. There is no Meta profile-write adapter in this
-- runtime, so an approved change waits for one, and the view says that in
-- words rather than leaving a button that would fail.

-- ---------------------------------------------------------------------------
-- Proposed profile changes
-- ---------------------------------------------------------------------------

create table public.meta_profile_changes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,

  -- Which identity. Instagram and Facebook are two profiles with two sets of
  -- fields, and treating them as one is how a bio ends up on the wrong one.
  platform text not null check (platform in ('instagram', 'facebook')),

  field text not null check (field in (
    'bio', 'website_url', 'display_name', 'category', 'contact_button', 'services', 'about')),
  current_value text,
  proposed_value text not null check (length(btrim(proposed_value)) between 1 and 4000),

  -- Where the proposed wording came from. A bio derived from a signed offer
  -- is a different thing from one somebody typed, and the difference is worth
  -- keeping.
  offer_version_id uuid,
  reason text,

  status text not null default 'drafted' check (status in (
    'drafted', 'approved', 'applied', 'failed', 'rejected')),
  approved_by uuid references public.profiles(id) on delete set null,
  approved_at timestamptz,
  rejection_reason text,
  applied_at timestamptz,
  external_ref text,
  last_error text,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (offer_version_id, client_id)
    references public.service_offer_versions(id, client_id) on delete set null
);

comment on table public.meta_profile_changes is
  'One proposed change to one field of one Meta identity, with what the profile says now beside what we would make it say. Nothing applies it: there is no Meta profile-write adapter in this runtime.';

create index meta_profile_changes_client_idx
  on public.meta_profile_changes (client_id, platform, created_at desc);

create trigger meta_profile_changes_updated_at before update on public.meta_profile_changes
  for each row execute function public.set_updated_at();

alter table public.meta_profile_changes enable row level security;
create policy meta_profile_changes_read on public.meta_profile_changes
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.meta_profile_changes to authenticated;
grant all on public.meta_profile_changes to service_role;

create function public.decide_meta_profile_change_v6(
  p_change_id uuid, p_approved boolean, p_reason text default null)
returns public.meta_profile_changes language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_change public.meta_profile_changes%rowtype;
begin
  select * into v_change from public.meta_profile_changes where id = p_change_id for update;
  if not found then raise exception 'No such change.' using errcode = 'P0001'; end if;
  if auth.role() is distinct from 'authenticated'
     or not (coalesce(public.is_admin(), false)
             or coalesce(auth.uid() = public.active_video_approval_manager(v_change.client_id), false)) then
    raise exception 'A signed-in admin or the assigned client manager must decide this.'
      using errcode = 'P0001';
  end if;
  if v_change.status <> 'drafted' then
    raise exception 'That change is %, not a draft.', v_change.status using errcode = 'P0001';
  end if;

  if not coalesce(p_approved, false) then
    if nullif(btrim(coalesce(p_reason, '')), '') is null then
      raise exception 'Say why it was rejected.' using errcode = 'P0001';
    end if;
    update public.meta_profile_changes
       set status = 'rejected', rejection_reason = btrim(p_reason)
     where id = p_change_id returning * into v_change;
    return v_change;
  end if;

  update public.meta_profile_changes
     set status = 'approved', approved_by = auth.uid(), approved_at = now()
   where id = p_change_id returning * into v_change;
  return v_change;
end $$;

revoke all on function public.decide_meta_profile_change_v6(uuid, boolean, text) from public, anon;
grant execute on function public.decide_meta_profile_change_v6(uuid, boolean, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Whose account this is, and whether it works
-- ---------------------------------------------------------------------------

-- The question v1 could not ask. Everything here already existed on
-- `client_integrations`; nothing read it in one place, so a disconnected
-- account looked exactly like a client with nothing scheduled.
create or replace view meta_identity_health with (security_invoker = true) as
select
  i.client_id,
  i.provider,
  coalesce(i.meta_page_id, i.credential_label) as account_ref,
  i.status,
  i.ingest_enabled,
  i.token_expires_at,
  i.health_detail,
  i.last_checked_at,
  case
    when i.token_expires_at is null then null
    else greatest(0, (i.token_expires_at::date - current_date))
  end as days_left,
  -- What is actually waiting on this identity, so a reconnect has a cost
  -- attached rather than being a tidy-up somebody does eventually.
  (select count(*) from public.scheduled_posts p
    -- `platform` is the post_platform enum, so it is cast rather than
    -- compared against the provider text.
    where p.client_id = i.client_id and p.platform::text = i.provider
      and p.publication_status in ('scheduled', 'publishing')) as posts_waiting,
  case
    when i.status = 'error'
      then 'This account is in error: ' || coalesce(i.health_detail, 'no detail recorded') || '.'
    when i.token_expires_at is not null and i.token_expires_at < now()
      then 'The token expired on ' || i.token_expires_at::date::text || '. Nothing can post or read.'
    when not public.integration_usable(i.client_id, i.provider)
      then 'No usable credential for this account.'
    when i.token_expires_at is not null and i.token_expires_at < now() + interval '7 days'
      then 'The token expires on ' || i.token_expires_at::date::text || '. Reconnect before it does.'
    else null
  end as blocker
from public.client_integrations i
where i.provider in ('instagram', 'facebook');

comment on view meta_identity_health is
  'Each Meta identity, whether its credential still works, and what is waiting on it. A disconnected account says so here instead of appearing as an empty post board.';

grant select on meta_identity_health to authenticated;

-- ---------------------------------------------------------------------------
-- What is present on the profile, and what it produced
-- ---------------------------------------------------------------------------

-- A mirror of what went out, with the campaign and the proof behind each
-- post. Content Distribution still owns publishing: this is the page that
-- says what is there.
create or replace view meta_profile_presence with (security_invoker = true) as
select
  p.id as post_id,
  p.client_id,
  p.platform,
  p.publication_status,
  p.external_id,
  p.external_url,
  p.published_at,
  p.scheduled_at,
  a.id as asset_id,
  -- The campaign runs through the idea, not the brief: `client_briefs` has
  -- `source_idea_id` and the idea is what knows which campaign asked for it.
  i.campaign_id,
  c.name as campaign_name,
  b.proof_asset_id,
  pa.title as proof_title,
  -- A placement pointing at the same asset means this post is carrying
  -- cleared proof, which is the thing that would have to come down if
  -- permission ended.
  exists (
    select 1 from public.proof_placements pl
     where pl.asset_id = a.id and pl.status in ('placed', 'verified')) as carries_placed_proof
from public.scheduled_posts p
left join public.client_media_assets a on a.id = p.asset_id
left join public.client_briefs b on b.id = a.brief_id
left join public.client_ideas i on i.id = b.source_idea_id
left join public.client_campaigns c on c.id = i.campaign_id
left join public.client_proof_assets pa on pa.id = b.proof_asset_id
where p.platform::text in ('instagram', 'facebook');

comment on view meta_profile_presence is
  'What is on the client''s Meta profiles, with the campaign and proof behind each post. Content Distribution owns publishing; this page says what is present.';

grant select on meta_profile_presence to authenticated;

select lock_down_definer_functions();

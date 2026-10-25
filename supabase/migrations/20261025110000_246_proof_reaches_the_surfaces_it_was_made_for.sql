-- G09 and G10: the placements proof distribution was built to record.
--
-- Migration 218 gave every destination a mode -- api, embed, assisted,
-- reference -- and a `bound` status with transitions `approved -> bound` and
-- `bound -> placed`, plus `bound_revision_id` and `bound_version_hash`
-- columns. Then it marked six destinations unsupported, because the things
-- that would do the placing did not exist yet.
--
-- Three of them do now, so this is mostly wiring rather than new design.
--
-- G09 -- THE EMBED DESTINATIONS, WHICH ARE THE CLIENT'S OWN SITE
--
-- `main_website`, `campaign_landing_page` and `seo_geo_content` are mode
-- `embed`: the proof is not sent anywhere, it is built into a page and goes
-- live when that page does. There was no page publisher that could be
-- trusted with exact bytes until migration 237, which is why these waited.
--
-- So `bound` finally means something: a placement bound to the page revision
-- that carries it, which becomes `placed` when that revision is published --
-- by a trigger on the publication, not by the placement sweep. The sweep
-- owns transports; this destination has none. If the page never publishes,
-- the placement stays `bound` and says so, which is the honest state for
-- proof sitting in an unpublished draft.
--
-- The binding is to a revision and a hash, not to a page. A page that is
-- rebuilt after binding is a different page, and the publication trigger
-- will not advance a placement whose bound revision is not the one that
-- shipped -- the same discipline 237 applies to the bytes themselves.
--
-- G10 -- THE DESTINATIONS THAT ALREADY EXECUTE SOMEWHERE ELSE
--
-- `organic_social` and `paid_advertising` are mode `api`, and their
-- transport belongs to another module: a proof-derived reel goes out through
-- scheduled_posts and the Meta adapters, an ad through the build. Those
-- paths work. What was missing was any record that the proof went with them,
-- so proof lineage stopped at the asset.
--
-- These placements are therefore recorded after the fact, and that needs
-- saying plainly: they are not a second approval. The content was already
-- approved through its own gate -- the post's human approval, the build's
-- exact-version approval -- and the placement points at that decision rather
-- than inventing one. Routing them back through drafted -> awaiting_approval
-- would ask a person to approve something that went out last week.
--
-- WHY A BOOKKEEPING ROW IS WORTH A MIGRATION
--
-- Retraction. When a customer withdraws permission, `main_website` and
-- `organic_social` were the two places the proof was most likely to be and
-- the two places nothing could find it. 218's retraction sweep already flags
-- every placement whose proof has gone; it could only flag placements that
-- existed. These rows are what make a published reel and a live case study
-- findable on the day the rights lapse, which is the only day it matters.

-- ---------------------------------------------------------------------------
-- The destinations that can now be placed
-- ---------------------------------------------------------------------------

update public.proof_destinations set supported = true, note =
  'Built into a page revision and published by the page pipeline. The placement binds to the revision and its hash, and becomes placed when that exact revision publishes.'
 where destination_key in ('main_website', 'campaign_landing_page', 'seo_geo_content');

update public.proof_destinations set supported = true, note =
  'A proof-derived asset goes out through scheduled_posts and the Meta adapters, which own the transport. The placement is recorded against the published post so the proof is findable when its rights lapse. Not a second approval: the post had its own.'
 where destination_key = 'organic_social';

update public.proof_destinations set supported = true, note =
  'A proof-derived creative ships through the Meta build, which owns the transport and the exact-version approval. The placement is recorded against the built objects so the proof is findable when its rights lapse.'
 where destination_key = 'paid_advertising';

update public.proof_destinations set supported = true, note =
  'Which proof a deployed sales agent is cleared to cite. A reference placement: the agent quotes it in conversations we do not record one by one, so the placement is the release rather than each mention.'
 where destination_key = 'sales_conversation';

-- A reference destination has no transport step: releasing proof to a sales
-- agent is the placement happening, so `approved -> placed` is its whole
-- journey. 218's transition table is data precisely so a new destination
-- shape can be admitted without rewriting the guard. The functions below
-- still check the destination, so this row does not let an api or embed
-- placement skip its queue.
insert into public.proof_placement_transitions (from_status, to_status)
values ('approved', 'placed')
on conflict (from_status, to_status) do nothing;

-- ---------------------------------------------------------------------------
-- G09: bind an approved placement to the page revision that carries it
-- ---------------------------------------------------------------------------

create or replace function public.bind_proof_placement_to_page_v6(
  p_placement_id uuid, p_page_id uuid, p_revision_id uuid)
returns public.proof_placements
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v public.proof_placements%rowtype;
  v_mode text;
  v_page public.client_pages%rowtype;
  v_hash text;
begin
  select * into v from public.proof_placements where id = p_placement_id for update;
  if not found then raise exception 'No such placement.' using errcode = 'P0001'; end if;

  if coalesce(auth.role(), '') <> 'service_role'
     and not (coalesce(public.is_admin(), false)
              or coalesce(auth.uid() = public.active_video_approval_manager(v.client_id), false)) then
    raise exception 'Only an admin or the assigned client manager can bind a placement.'
      using errcode = 'P0001';
  end if;

  select mode into v_mode from public.proof_destinations where destination_key = v.destination_key;
  if v_mode is distinct from 'embed' then
    raise exception 'Only an embed destination is bound to a page. % is %.',
      v.destination_key, coalesce(v_mode, 'unknown') using errcode = 'P0001';
  end if;
  if v.status <> 'approved' then
    raise exception 'That placement is %, not approved. Only an approved placement can be bound.',
      v.status using errcode = 'P0001';
  end if;

  select * into v_page from public.client_pages where id = p_page_id;
  if not found then raise exception 'No such page.' using errcode = 'P0001'; end if;
  if v_page.client_id <> v.client_id then
    raise exception 'That page belongs to a different client.' using errcode = 'P0001';
  end if;

  if not exists (select 1 from public.client_page_revisions r
                  where r.id = p_revision_id and r.page_id = p_page_id) then
    raise exception 'That revision does not belong to that page.' using errcode = 'P0001';
  end if;

  -- The hash of what is in the page now. The publication trigger compares
  -- against this, so proof bound to a draft that is later regenerated does
  -- not ride along on bytes nobody checked it against.
  if v_page.html is null or length(btrim(v_page.html)) = 0 then
    raise exception 'That page has no built HTML to bind to.' using errcode = 'P0001';
  end if;
  v_hash := encode(sha256(convert_to(v_page.html, 'UTF8')), 'hex');

  update public.proof_placements
     set status = 'bound',
         bound_revision_id = p_revision_id,
         bound_version_hash = v_hash
   where id = p_placement_id
   returning * into v;

  insert into public.proof_placement_events (placement_id, client_id, kind, detail)
  values (p_placement_id, v.client_id, 'bound',
          'Bound to revision ' || p_revision_id::text || ' of this page. It places when that revision publishes.');
  return v;
end $$;

comment on function public.bind_proof_placement_to_page_v6(uuid, uuid, uuid) is
  'Binds an approved embed placement to the page revision that carries it. It becomes placed when that exact revision publishes, and stays bound -- visibly -- if it never does.';

revoke all on function public.bind_proof_placement_to_page_v6(uuid, uuid, uuid) from public, anon;
grant execute on function public.bind_proof_placement_to_page_v6(uuid, uuid, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- G09: a publication places what was bound to it
-- ---------------------------------------------------------------------------

create or replace function public.place_bound_proof_on_publication()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_placed integer := 0;
begin
  -- Only placements bound to the revision that actually shipped, and whose
  -- bound hash matches the bytes recorded for this publication. A page
  -- regenerated after binding publishes without carrying the placement,
  -- which leaves it bound rather than falsely placed.
  with advanced as (
    update public.proof_placements p
       set status = 'placed',
           external_url = new.published_url,
           placed_at = now()
     where p.client_id = new.client_id
       and p.status = 'bound'
       and p.bound_revision_id = new.revision_id
       and p.bound_version_hash = new.rendered_sha256
     returning p.id, p.client_id
  ), logged as (
    insert into public.proof_placement_events (placement_id, client_id, kind, detail)
    select a.id, a.client_id, 'placed',
           'Published with revision ' || new.revision_id::text || ' at ' || new.published_url
      from advanced a
    returning 1
  )
  select count(*)::int into v_placed from logged;
  return new;
end $$;

comment on function public.place_bound_proof_on_publication() is
  'Advances embed placements from bound to placed when the revision they were bound to is published, matching on the revision and the byte hash so a regenerated page does not carry proof nobody checked against it.';

drop trigger if exists place_bound_proof_on_publication on public.campaign_page_publications;
create trigger place_bound_proof_on_publication
  after insert on public.campaign_page_publications
  for each row execute function public.place_bound_proof_on_publication();

-- ---------------------------------------------------------------------------
-- G10: record where proof actually went, after the fact
-- ---------------------------------------------------------------------------

-- Service-role only, all three. They are called by the modules that own the
-- transport, immediately after it succeeded, and they record rather than
-- decide -- so there is no reason for a browser to be able to call them and
-- one very good reason it should not.
create or replace function public.record_proof_placement_for_post_v6(p_post_id uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_post public.scheduled_posts%rowtype;
  v_proof uuid;
  v_campaign uuid;
  v_existing uuid;
  v_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record a placement.';
  end if;

  select * into v_post from public.scheduled_posts where id = p_post_id;
  if not found then raise exception 'No such post.'; end if;
  if v_post.published_at is null then
    raise exception 'That post has not published, so there is nothing to record.';
  end if;

  -- The only path a post has to proof: asset -> brief -> the proof the brief
  -- was built from. A post with no proof behind it is not an error; there is
  -- simply nothing to record.
  select b.proof_asset_id, i.campaign_id into v_proof, v_campaign
    from public.client_media_assets a
    join public.client_briefs b on b.id = a.brief_id
    left join public.client_ideas i on i.id = b.source_idea_id
   where a.id = v_post.asset_id;
  if v_proof is null then return null; end if;

  -- One placement per post per proof. A re-run of the publisher must not
  -- produce a second row claiming the same proof went out twice.
  select id into v_existing from public.proof_placements
   where destination_key = 'organic_social' and external_id = p_post_id::text
     and source_proof_id = v_proof;
  if v_existing is not null then return v_existing; end if;

  insert into public.proof_placements (
    client_id, destination_key, source_proof_id, proof_id, asset_id, campaign_id,
    status, external_id, external_url, placed_at, payload_hash)
  values (
    v_post.client_id, 'organic_social', v_proof, v_proof, v_post.asset_id, v_campaign,
    'placed', p_post_id::text, v_post.external_url, v_post.published_at,
    encode(sha256(convert_to('post:' || p_post_id::text, 'UTF8')), 'hex'))
  returning id into v_id;

  insert into public.proof_placement_events (placement_id, client_id, kind, detail)
  values (v_id, v_post.client_id, 'placed',
          'Recorded after the post published. The post carried its own approval; this row exists so the proof is findable if its rights lapse.');
  return v_id;
end $$;

comment on function public.record_proof_placement_for_post_v6(uuid) is
  'Records that a published post carried proof, so the proof is findable when its rights lapse. Idempotent per post and proof. Not an approval: the post had its own.';

revoke all on function public.record_proof_placement_for_post_v6(uuid) from public, anon, authenticated;
grant execute on function public.record_proof_placement_for_post_v6(uuid) to service_role;

-- Takes the campaign rather than an execution: the Meta build runs as its own
-- agent job and has no campaign_action_executions row to point at, so a
-- signature demanding one could never be called from the place that knows the
-- objects were created.
drop function if exists public.record_proof_placement_for_ad_v6(uuid, text, text);

create or replace function public.record_proof_placement_for_ad_v6(
  p_campaign_id uuid, p_external_id text, p_external_url text default null,
  p_approval_id uuid default null)
returns integer language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_client uuid;
  v_count integer := 0;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record a placement.';
  end if;
  select client_id into v_client from public.client_campaigns where id = p_campaign_id;
  if v_client is null then raise exception 'No such campaign.'; end if;
  if nullif(btrim(coalesce(p_external_id, '')), '') is null then
    raise exception 'Record which external object carries the proof.';
  end if;

  -- Every distinct proof behind the creative this campaign built from.
  with proofs as (
    select distinct b.proof_asset_id as proof_id
      from public.campaign_artifacts ca
      join public.client_media_assets a on a.id = ca.asset_id
      join public.client_briefs b on b.id = a.brief_id
     where ca.campaign_id = p_campaign_id and b.proof_asset_id is not null
  ), inserted as (
    insert into public.proof_placements (
      client_id, destination_key, source_proof_id, proof_id, campaign_id, approval_id,
      status, external_id, external_url, placed_at, payload_hash)
    select
      v_client, 'paid_advertising', p.proof_id, p.proof_id, p_campaign_id,
      p_approval_id, 'placed', p_external_id, p_external_url, now(),
      encode(sha256(convert_to('ad:' || p_external_id || ':' || p.proof_id::text, 'UTF8')), 'hex')
      from proofs p
     where not exists (
       select 1 from public.proof_placements existing
        where existing.destination_key = 'paid_advertising'
          and existing.external_id = p_external_id
          and existing.source_proof_id = p.proof_id)
    returning id, client_id
  )
  insert into public.proof_placement_events (placement_id, client_id, kind, detail)
  select i.id, i.client_id, 'placed',
         'Recorded against the built ad objects. The build carried the exact-version approval; this row exists so the proof is findable if its rights lapse.'
    from inserted i;

  select count(*)::int into v_count from public.proof_placements
   where destination_key = 'paid_advertising' and external_id = p_external_id;
  return v_count;
end $$;

comment on function public.record_proof_placement_for_ad_v6(uuid, text, text, uuid) is
  'Records every proof behind a campaign''s creative against the external ad object a build created. Idempotent per object and proof. Not an approval: the build carried its own.';

revoke all on function public.record_proof_placement_for_ad_v6(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.record_proof_placement_for_ad_v6(uuid, text, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- G10: which proof a sales agent may cite
-- ---------------------------------------------------------------------------

-- A reference placement, and the one of the three that is a decision rather
-- than bookkeeping: releasing proof to an agent is a person saying it may be
-- quoted in conversations nobody reads one by one. So it goes through the
-- normal approval path and this only records the release.
create or replace function public.release_proof_to_sales_agent_v6(p_placement_id uuid, p_deployment_id uuid)
returns public.proof_placements
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v public.proof_placements%rowtype;
  v_deployment public.client_sales_agent_deployments%rowtype;
begin
  select * into v from public.proof_placements where id = p_placement_id for update;
  if not found then raise exception 'No such placement.' using errcode = 'P0001'; end if;
  if coalesce(auth.role(), '') <> 'service_role'
     and not (coalesce(public.is_admin(), false)
              or coalesce(auth.uid() = public.active_video_approval_manager(v.client_id), false)) then
    raise exception 'Only an admin or the assigned client manager can release proof to an agent.'
      using errcode = 'P0001';
  end if;
  if v.destination_key <> 'sales_conversation' then
    raise exception 'That placement is for %, not a sales conversation.', v.destination_key
      using errcode = 'P0001';
  end if;
  if v.status <> 'approved' then
    raise exception 'That placement is %, not approved.', v.status using errcode = 'P0001';
  end if;

  select * into v_deployment from public.client_sales_agent_deployments where id = p_deployment_id;
  if not found then raise exception 'No such deployment.' using errcode = 'P0001'; end if;
  if v_deployment.client_id <> v.client_id then
    raise exception 'That deployment belongs to a different client.' using errcode = 'P0001';
  end if;
  if not v_deployment.enabled then
    raise exception 'That deployment is disabled, so nothing would cite the proof.'
      using errcode = 'P0001';
  end if;

  update public.proof_placements
     set status = 'placed', external_id = p_deployment_id::text, placed_at = now(),
         placed_by = auth.uid()
   where id = p_placement_id returning * into v;

  insert into public.proof_placement_events (placement_id, client_id, kind, detail)
  values (p_placement_id, v.client_id, 'placed',
          'Released to sales agent deployment ' || p_deployment_id::text || '.');
  return v;
end $$;

comment on function public.release_proof_to_sales_agent_v6(uuid, uuid) is
  'Records that approved proof has been released to a deployed sales agent to cite. A reference placement: the agent quotes it in conversations we do not record one by one.';

revoke all on function public.release_proof_to_sales_agent_v6(uuid, uuid) from public, anon;
grant execute on function public.release_proof_to_sales_agent_v6(uuid, uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Where a client's proof actually is
-- ---------------------------------------------------------------------------

drop view if exists proof_surface_coverage;

create view proof_surface_coverage with (security_invoker = true) as
select
  pa.client_id,
  pa.id as proof_asset_id,
  pa.title,
  pa.proof_type,
  pa.usage_rights,
  pa.expires_on,
  count(p.id) filter (where p.status in ('placed', 'verified'))::int as live_placements,
  count(p.id) filter (where p.status = 'bound')::int as bound_not_published,
  count(p.id) filter (where p.status = 'retraction_required')::int as needs_retracting,
  array_remove(array_agg(distinct p.destination_key)
    filter (where p.status in ('placed', 'verified')), null) as live_on,
  case
    when pa.usage_rights <> 'approved'
         and count(p.id) filter (where p.status in ('placed', 'verified')) > 0
      then 'This proof is live somewhere and its rights are ' || pa.usage_rights || '.'
    when pa.expires_on is not null and pa.expires_on < current_date
         and count(p.id) filter (where p.status in ('placed', 'verified')) > 0
      then 'This proof is live somewhere and permission expired on ' || pa.expires_on::text || '.'
    when count(p.id) filter (where p.status = 'retraction_required') > 0
      then count(p.id) filter (where p.status = 'retraction_required')::text
           || ' placement(s) are waiting to be retracted.'
    when count(p.id) filter (where p.status = 'bound') > 0
         and count(p.id) filter (where p.status in ('placed', 'verified')) = 0
      then 'Bound into a page that has not published, so it is not live anywhere yet.'
    else null
  end as problem
from public.client_proof_assets pa
left join public.proof_placements p on p.source_proof_id = pa.id
group by pa.client_id, pa.id, pa.title, pa.proof_type, pa.usage_rights, pa.expires_on;

comment on view proof_surface_coverage is
  'Every proof asset and the surfaces it is actually live on, which is the question the day a customer withdraws permission. A proof live somewhere with rights that are not approved is the row that matters.';

grant select on proof_surface_coverage to authenticated;

select lock_down_definer_functions();

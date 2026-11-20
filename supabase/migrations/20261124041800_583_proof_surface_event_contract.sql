-- Migration 246 used (kind, detail) for proof events, while the real table
-- has (event, actor, detail). Its post recorder also omitted the required
-- idempotency key. Correct the actual execution contract without rewriting
-- historical placement or event rows.
begin;

alter table public.proof_placement_events
  drop constraint if exists proof_placement_events_event_check;
alter table public.proof_placement_events
  add constraint proof_placement_events_event_check check (event in (
    'drafted','requested','approved','rejected','queued','claimed','bound',
    'placed','verified','cited','failed','retraction_required','retracted'));

create or replace function public.bind_proof_placement_to_page_v6(
  p_placement_id uuid, p_page_id uuid, p_revision_id uuid)
returns public.proof_placements
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v public.proof_placements%rowtype;
  v_mode text;
  v_page public.client_pages%rowtype;
  v_hash text;
begin
  select * into v from public.proof_placements where id=p_placement_id for update;
  if v.id is null then raise exception 'No such placement.' using errcode='P0001'; end if;
  if auth.role()<>'service_role'
    and not (coalesce(public.is_admin(),false)
      or coalesce(auth.uid()=public.active_video_approval_manager(v.client_id),false)) then
    raise exception 'Only an admin or the assigned client manager can bind a placement.'
      using errcode='42501';
  end if;
  select mode into v_mode from public.proof_destinations
    where destination_key=v.destination_key;
  if v_mode is distinct from 'embed' then
    raise exception 'Only an embed destination is bound to a page.' using errcode='P0001';
  end if;
  if v.status<>'approved' then
    raise exception 'That placement is %, not approved.',v.status using errcode='P0001';
  end if;
  select * into v_page from public.client_pages where id=p_page_id;
  if v_page.id is null or v_page.client_id is distinct from v.client_id then
    raise exception 'A page of the same client is required.' using errcode='P0001';
  end if;
  if not exists(select 1 from public.client_page_revisions r
      where r.id=p_revision_id and r.page_id=p_page_id and r.client_id=v.client_id) then
    raise exception 'That revision does not belong to this client page.' using errcode='P0001';
  end if;
  if nullif(btrim(v_page.html),'') is null then
    raise exception 'That page has no built HTML to bind to.' using errcode='P0001';
  end if;
  v_hash:=encode(sha256(convert_to(v_page.html,'UTF8')),'hex');
  update public.proof_placements
     set status='bound',bound_revision_id=p_revision_id,bound_version_hash=v_hash
   where id=p_placement_id returning * into v;
  insert into public.proof_placement_events
    (placement_id,client_id,event,actor,detail)
  values(p_placement_id,v.client_id,'bound',
    case when auth.role()='service_role' then 'system' else 'human' end,
    'Bound to page revision '||p_revision_id::text||' at hash '||v_hash||'.');
  return v;
end $$;

create or replace function public.place_bound_proof_on_publication()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  with advanced as (
    update public.proof_placements p
       set status='placed',external_url=new.published_url,
           placed_at=new.published_at
     where p.client_id=new.client_id and p.status='bound'
       and p.bound_revision_id=new.revision_id
       and p.bound_version_hash=new.rendered_sha256
     returning p.id,p.client_id
  )
  insert into public.proof_placement_events
    (placement_id,client_id,event,actor,detail,external_ref)
  select a.id,a.client_id,'placed','system',
    'Published with exact page revision '||new.revision_id::text||'.',
    new.published_url from advanced a;
  return new;
end $$;

create or replace function public.record_proof_placement_for_post_v6(p_post_id uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_post public.scheduled_posts%rowtype;
  v_proof uuid;
  v_campaign uuid;
  v_key text;
  v_id uuid;
begin
  if auth.role()<>'service_role' then
    raise exception 'Only the internal service may record a placement.' using errcode='42501';
  end if;
  select * into v_post from public.scheduled_posts where id=p_post_id for share;
  if v_post.id is null then raise exception 'No such post.' using errcode='P0001'; end if;
  if v_post.publication_status is distinct from 'published'
    or v_post.published_at is null
    or nullif(btrim(v_post.external_id),'') is null then
    raise exception 'A published post with a provider ID is required.' using errcode='P0001';
  end if;
  select b.proof_asset_id,i.campaign_id into v_proof,v_campaign
    from public.client_media_assets a
    join public.client_briefs b on b.id=a.brief_id and b.client_id=v_post.client_id
    left join public.client_ideas i on i.id=b.source_idea_id and i.client_id=v_post.client_id
   where a.id=v_post.asset_id and a.client_id=v_post.client_id;
  if v_proof is null then return null; end if;
  if not exists(select 1 from public.client_proof_assets p
      where p.id=v_proof and p.client_id=v_post.client_id) then
    raise exception 'The post proof belongs to another client or is missing.' using errcode='P0001';
  end if;
  v_key:='organic-post:'||p_post_id::text||':'||v_proof::text;
  select id into v_id from public.proof_placements
    where client_id=v_post.client_id and idempotency_key=v_key;
  if v_id is not null then return v_id; end if;
  insert into public.proof_placements
    (client_id,destination_key,source_proof_id,proof_id,asset_id,campaign_id,
     status,external_id,external_url,placed_at,payload_hash,idempotency_key)
  values(v_post.client_id,'organic_social',v_proof,v_proof,v_post.asset_id,v_campaign,
    'placed',v_post.external_id,v_post.external_url,v_post.published_at,
    encode(sha256(convert_to('post:'||p_post_id::text||':'||v_post.external_id,'UTF8')),'hex'),
    v_key)
  on conflict (client_id,idempotency_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from public.proof_placements
      where client_id=v_post.client_id and idempotency_key=v_key;
    return v_id;
  end if;
  insert into public.proof_placement_events
    (placement_id,client_id,event,actor,detail,external_ref)
  values(v_id,v_post.client_id,'placed','system',
    'Recorded after the post published through its own exact approval.',
    coalesce(v_post.external_url,v_post.external_id));
  return v_id;
end $$;

create or replace function public.release_proof_to_sales_agent_v6(
  p_placement_id uuid,p_deployment_id uuid)
returns public.proof_placements language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v public.proof_placements%rowtype;
  v_deployment public.client_sales_agent_deployments%rowtype;
begin
  select * into v from public.proof_placements where id=p_placement_id for update;
  if v.id is null then raise exception 'No such placement.' using errcode='P0001'; end if;
  if auth.role()<>'service_role'
    and not (coalesce(public.is_admin(),false)
      or coalesce(auth.uid()=public.active_video_approval_manager(v.client_id),false)) then
    raise exception 'Only an admin or assigned client manager can release proof.'
      using errcode='42501';
  end if;
  if v.destination_key<>'sales_conversation' or v.status<>'approved' then
    raise exception 'Approved sales-conversation placement required.' using errcode='P0001';
  end if;
  select * into v_deployment from public.client_sales_agent_deployments
    where id=p_deployment_id;
  if v_deployment.id is null or v_deployment.client_id is distinct from v.client_id
    or not v_deployment.enabled then
    raise exception 'An enabled same-client sales agent deployment is required.'
      using errcode='P0001';
  end if;
  update public.proof_placements
     set status='placed',external_id=p_deployment_id::text,
         placed_at=now(),placed_by=case when auth.role()='authenticated' then auth.uid() else null end
   where id=p_placement_id returning * into v;
  insert into public.proof_placement_events
    (placement_id,client_id,event,actor,detail,external_ref)
  values(p_placement_id,v.client_id,'placed',
    case when auth.role()='service_role' then 'system' else 'human' end,
    'Released to sales agent deployment '||p_deployment_id::text||'.',
    p_deployment_id::text);
  return v;
end $$;

select public.lock_down_definer_functions();
commit;

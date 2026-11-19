-- An acknowledged provider ID is not proof that the intended account
-- serves the post. Keep old placements for audit, but require exact account
-- read-back before creating a new organic proof placement.
begin;
create or replace function public.record_proof_placement_for_post_v6(p_post_id uuid)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare v_post public.scheduled_posts%rowtype;
  v_proof uuid;
  v_campaign uuid;
  v_key text;
  v_id uuid;
  v_format public.content_format;
  v_expected integer;
  v_acknowledged integer;
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
  select a.content_format into v_format from public.client_media_assets a
    where a.id=v_post.asset_id and a.client_id=v_post.client_id;
  if v_format='story' then
    select count(*) into v_expected from public.client_media_frames f
      where f.asset_id=v_post.asset_id;
    select count(*) into v_acknowledged from public.post_frame_publications f
      where f.post_id=v_post.id and f.client_id=v_post.client_id;
    if v_expected<1 or v_acknowledged<>v_expected
      or exists(select 1 from public.post_frame_publications f
        left join public.organic_provider_readback_latest_v8 r
          on r.post_id=f.post_id and r.client_id=f.client_id
          and r.frame_position=f.position and r.external_id=f.external_id
          and r.state='verified'
        where f.post_id=v_post.id and f.client_id=v_post.client_id
          and r.id is null) then
      raise exception 'Every published story frame needs verified provider account read-back.'
        using errcode='23514';
    end if;
  elsif not exists(select 1 from public.organic_provider_readback_latest_v8 r
      where r.post_id=v_post.id and r.client_id=v_post.client_id
        and r.frame_position=0 and r.external_id=v_post.external_id
        and r.state='verified') then
    raise exception 'Verified provider account read-back is required before proof placement.'
      using errcode='23514';
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
revoke all on function public.record_proof_placement_for_post_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.record_proof_placement_for_post_v6(uuid)
  to service_role;
select public.lock_down_definer_functions();
commit;

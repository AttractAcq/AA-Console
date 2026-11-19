-- Meta Profile must distinguish a local published row from exact-account
-- provider presence. For stories every expected frame needs a matching read.
begin;
create or replace view public.meta_profile_presence with (security_invoker=true) as
select
  p.id as post_id,p.client_id,p.platform,p.publication_status,p.external_id,
  p.external_url,p.published_at,p.scheduled_at,a.id as asset_id,
  i.campaign_id,c.name as campaign_name,b.proof_asset_id,pa.title as proof_title,
  exists(select 1 from public.proof_placements pl
    where pl.asset_id=a.id and pl.status in ('placed','verified')) as carries_placed_proof,
  case
    when p.publication_status='uncertain' then 'uncertain'
    when p.publication_status is distinct from 'published' then 'not_published'
    when nullif(btrim(p.external_id),'') is null then 'no_provider_id'
    when a.content_format='story' then
      case
        when (select count(*) from public.client_media_frames f where f.asset_id=a.id)=0
          then 'missing'
        when (select count(*) from public.post_frame_publications f
          where f.post_id=p.id and f.client_id=p.client_id)
          is distinct from (select count(*) from public.client_media_frames f
            where f.asset_id=a.id) then 'partial'
        when exists(select 1 from public.post_frame_publications f
          join public.organic_provider_readback_latest_v8 r
            on r.post_id=f.post_id and r.client_id=f.client_id
            and r.frame_position=f.position
          where f.post_id=p.id and f.client_id=p.client_id
            and (r.external_id is distinct from f.external_id or r.state='mismatch'))
          then 'mismatch'
        when exists(select 1 from public.post_frame_publications f
          join public.organic_provider_readback_latest_v8 r
            on r.post_id=f.post_id and r.client_id=f.client_id
            and r.frame_position=f.position
          where f.post_id=p.id and f.client_id=p.client_id and r.state='unavailable')
          then 'unavailable'
        when exists(select 1 from public.post_frame_publications f
          left join public.organic_provider_readback_latest_v8 r
            on r.post_id=f.post_id and r.client_id=f.client_id
            and r.frame_position=f.position
            and r.external_id=f.external_id and r.state='verified'
          where f.post_id=p.id and f.client_id=p.client_id and r.id is null)
          then 'missing'
        else 'verified'
      end
    else coalesce((select case
        when r.external_id is distinct from p.external_id then 'mismatch'
        else r.state end
      from public.organic_provider_readback_latest_v8 r
      where r.post_id=p.id and r.client_id=p.client_id and r.frame_position=0),
      'missing')
  end as provider_readback_state,
  (select max(r.checked_at) from public.organic_provider_readback_latest_v8 r
    where r.post_id=p.id and r.client_id=p.client_id) as provider_readback_at
from public.scheduled_posts p
left join public.client_media_assets a on a.id=p.asset_id and a.client_id=p.client_id
left join public.client_briefs b on b.id=a.brief_id and b.client_id=p.client_id
left join public.client_ideas i on i.id=b.source_idea_id and i.client_id=p.client_id
left join public.client_campaigns c on c.id=i.campaign_id and c.client_id=p.client_id
left join public.client_proof_assets pa on pa.id=b.proof_asset_id and pa.client_id=p.client_id
where p.platform::text in ('instagram','facebook');
comment on view public.meta_profile_presence is
  'Recorded Meta post activity with separate exact-account provider readback; published alone does not establish presence.';
revoke all on public.meta_profile_presence from public,anon,authenticated,service_role;
grant select on public.meta_profile_presence to authenticated,service_role;
commit;

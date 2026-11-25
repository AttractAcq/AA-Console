-- The runtime uploads the reviewed bytes privately, reads them back, then
-- commits their identity, the pending asset and its source in one transaction.
begin;
create function public.file_reviewed_proof_text(
  p_client_id uuid, p_request_id uuid, p_brief_id uuid, p_revision timestamptz,
  p_rights_id uuid, p_actor_id uuid, p_verified_object jsonb default null
) returns jsonb language plpgsql security invoker
set search_path = pg_catalog, public as $$
declare
  r public.proof_production_requests%rowtype;
  b public.client_briefs%rowtype;
  p public.client_proof_assets%rowtype;
  a public.client_media_assets%rowtype;
  o storage.objects%rowtype;
  v_path text;
  v_hash text;
  v_identity jsonb;
begin
  if auth.role() is distinct from 'service_role' or not exists (
    select 1 from public.profiles where id=p_actor_id and not is_bot
      and (role='admin' or id=public.active_video_approval_manager(p_client_id))
  ) then raise exception 'A permitted human operator is required.' using errcode='42501'; end if;
  select * into strict r from public.proof_production_requests
    where id=p_request_id and client_id=p_client_id and not auto_produce
      and source_asset_id is null and production_job_id is null for update;
  select * into strict b from public.client_briefs
    where id=p_brief_id and client_id=r.client_id and source_idea_id=r.idea_id
      and job_id=r.job_id and proof_asset_id=r.source_proof_id and purpose='client'
      and media_type='text' and content_format='single' for update;
  select * into strict p from public.client_proof_assets
    where id=b.proof_asset_id and client_id=r.client_id and media_type='text'
      and usage_rights='approved' and approved_rights_request_id=p_rights_id for share;
  if public.proof_rights_source_state_v6(p_rights_id) is distinct from 'source_decided'
    or not exists (select 1 from public.approval_decision_events_v6
      where request_id=p_rights_id and decision='approved')
    or (p.expires_on is not null and p.expires_on < current_date)
    or nullif(btrim(p.body),'') is null or b.script is distinct from p.body then
    raise exception 'The reviewed Script must match the currently cleared raw text exactly.';
  end if;
  v_hash := encode(sha256(convert_to(p.body,'UTF8')),'hex');
  v_path := format('%s/proof-drafts/%s/%s/%s.txt',r.client_id,r.id,p_rights_id,v_hash);
  select * into a from public.client_media_assets where id=r.id;
  if a.id is not null then
    if a.client_id=r.client_id and a.brief_id=b.id and a.storage_path=v_path
      and a.delivery_bytes_sha256=v_hash and r.production_status='complete' then
      return jsonb_build_object('asset_id',a.id);
    end if;
    raise exception 'This proof request already has a different delivery.';
  end if;
  if b.updated_at is distinct from p_revision or b.archived_at is not null
    or b.status<>'draft' or r.production_status<>'briefing'
    or exists (select 1 from public.client_media_assets where brief_id=b.id)
    or exists (select 1 from public.creative_generations where brief_id=b.id)
    or exists (select 1 from public.job_assignments where brief_id=b.id) then
    raise exception 'Refresh the draft and check for existing work before filing.';
  end if;
  select * into o from storage.objects where bucket_id='client-media' and name=v_path for share;
  if o.id is not null then
    v_identity := jsonb_build_object('id',o.id,'version',o.version,'updated_at',o.updated_at);
  end if;
  if p_verified_object is null then
    return jsonb_build_object('script',b.script,'path',v_path,'object',v_identity);
  end if;
  if v_identity is null or p_verified_object is distinct from v_identity then
    raise exception 'The stored file changed during verification.';
  end if;
  insert into public.client_media_assets(id, client_id, brief_id, title, media_type,
      content_format, review_status, storage_path, uploaded_by)
    values(r.id,r.client_id,b.id,b.title,'text','single','pending',v_path,p_actor_id);
  perform public.attest_creative_storage_bytes_v6(r.id,v_path,v_hash,octet_length(convert_to(b.script,'UTF8')),
    o.id,o.version,o.updated_at);
  update public.client_briefs set status='complete' where id=b.id;
  update public.proof_production_requests set production_status='complete' where id=r.id;
  return jsonb_build_object('asset_id',r.id);
end $$;
revoke all on function public.file_reviewed_proof_text(uuid,uuid,uuid,timestamptz,uuid,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function public.file_reviewed_proof_text(uuid,uuid,uuid,timestamptz,uuid,uuid,jsonb) to service_role;
create or replace view public.proof_production_attempts_v7 with (security_invoker = true) as
with candidates as (
  select r.id as request_id, r.client_id, cr.id as attempt_id,
    cr.asset_id, 'creative_render'::text as attempt_kind,
    cr.status::text as attempt_status, cr.cost_usd,
    cr.created_at, cr.updated_at as finished_at,
    (g.remake_feedback is not null) as revised
  from public.proof_production_requests r
  join public.client_briefs b on b.source_idea_id = r.idea_id
    and b.client_id = r.client_id
  join public.creative_generations g on g.brief_id = b.id
    and g.client_id = r.client_id
  join public.creative_renders cr on cr.generation_id = g.id
    and cr.client_id = r.client_id
  union all
  select r.id, r.client_id, vc.id, vc.asset_id,
    'video_cut'::text, vc.verdict, null::numeric,
    vc.created_at, vc.reviewed_at,
    (vc.attempt > 1 and j.params ? 'v5_video_revision')
  from public.proof_production_requests r
  join public.client_briefs b on b.source_idea_id = r.idea_id
    and b.client_id = r.client_id
  join public.client_media_assets m on m.brief_id = b.id
    and m.client_id = r.client_id
  join public.video_render_candidates vc on vc.asset_id = m.id
    and vc.client_id = r.client_id
  join public.agent_jobs j on j.id = vc.job_id
  union all
  select r.id, r.client_id, m.id, m.id,
    'human_delivery'::text, 'delivered'::text, null::numeric,
    m.created_at, m.updated_at, false
  from public.proof_production_requests r
  join public.client_briefs b on b.source_idea_id = r.idea_id
    and b.client_id = r.client_id
  join public.client_media_assets m on m.brief_id = b.id
    and m.client_id = r.client_id
  where exists (select 1 from public.assignment_deliveries_v7 d
      where d.asset_id = m.id and d.client_id = r.client_id)
    and not exists (select 1 from public.creative_renders cr where cr.asset_id = m.id)
  union all
  select r.id, r.client_id, m.id, m.id,
    'verbatim_filing'::text, 'delivered'::text, 0::numeric,
    m.created_at, m.created_at, false
  from public.proof_production_requests r
  join public.client_briefs b on b.client_id=r.client_id and b.source_idea_id=r.idea_id
    and b.proof_asset_id=r.source_proof_id
  join public.client_media_assets m on m.id=r.id and m.brief_id=b.id and m.client_id=r.client_id
  where not r.auto_produce and r.production_status='complete' and m.media_type='text'
    and m.delivery_bytes_sha256 is not null
)
select c.request_id, c.client_id, c.attempt_id, c.asset_id,
  c.attempt_kind, c.attempt_status, c.cost_usd, c.created_at,
  c.finished_at,
  case when c.finished_at is not null then
    greatest(0,extract(epoch from c.finished_at-c.created_at))::integer
    else null end as latency_seconds,
  c.revised, m.review_status::text as human_review_status,
  m.source_asset_id
from candidates c
left join public.client_media_assets m on m.id = c.asset_id
  and m.client_id = c.client_id;
commit;

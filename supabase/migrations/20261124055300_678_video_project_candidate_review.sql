-- Internal creative review is bound to the exact, probed render. The first
-- requested aspect receives an independent review; a derivative may inherit
-- only its accepted verdict and still needs its own passing physical probe.
create function public.decide_video_project_render_candidate_v1(
  p_candidate_id uuid,p_verdict text,p_creative_review jsonb default null,
  p_rejection_reason text default null
) returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public,storage as $$
declare c public.video_project_render_candidates_v1%rowtype;
  p public.video_projects%rowtype;
  first_candidate public.video_project_render_candidates_v1%rowtype;
  o storage.objects%rowtype;
  review jsonb;
  check_count integer;
  distinct_count integer;
  bad_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service creative review only.' using errcode='42501'; end if;
  select * into c from public.video_project_render_candidates_v1
    where id=p_candidate_id for update;
  if c.id is null then
    raise exception 'Render candidate does not exist.' using errcode='23514'; end if;
  select * into p from public.video_projects where id=c.project_id for update;
  if p.id is null or p.client_id is distinct from c.client_id
    or p.ir_version is distinct from c.ir_version or p.stage is distinct from 'timed'
    or not public.video_project_source_current_v1(p.id) then
    raise exception 'Render candidate is not current.' using errcode='23514'; end if;
  if p_verdict not in ('accepted','rejected') then
    raise exception 'Choose accepted or rejected.' using errcode='23514'; end if;
  if p_verdict='rejected' and nullif(btrim(coalesce(p_rejection_reason,'')),'') is null then
    raise exception 'A rejection reason is required.' using errcode='23514'; end if;
  if p_verdict='accepted' and p_rejection_reason is not null then
    raise exception 'An accepted candidate cannot have a rejection reason.'
      using errcode='23514'; end if;
  select * into o from storage.objects
    where bucket_id='client-media' and name=c.storage_path;
  if o.id is null or o.id is distinct from c.object_id
    or o.version is distinct from c.object_version
    or o.updated_at is distinct from c.object_updated_at then
    raise exception 'Render candidate Storage object changed before review.'
      using errcode='23514'; end if;
  if c.aspect = p.aspects[1] then
    review:=p_creative_review;
    if review is not null then
      if jsonb_typeof(review)<>'object'
        or review->>'result' not in ('pass','fail')
        or nullif(btrim(coalesce(review->>'summary','')),'') is null
        or jsonb_typeof(review->'checks') is distinct from 'array' then
        raise exception 'A structured creative review is required.'
          using errcode='23514'; end if;
      select count(*),count(distinct item->>'area'),
        count(*) filter (where item->>'area' not in (
          'text_overflow','caption_overlap','contrast','safe_area',
          'reading_time','brand_token','empty_frame','narration_visual_match')
          or item->>'verdict' not in ('pass','fail')
          or nullif(btrim(coalesce(item->>'reason','')),'') is null)
        into check_count,distinct_count,bad_count
        from jsonb_array_elements(review->'checks') item;
      if check_count<>8 or distinct_count<>8 or bad_count<>0 then
        raise exception 'Creative review must cover all eight areas once.'
          using errcode='23514'; end if;
    end if;
    if p_verdict='accepted' and (review is null
      or review->>'result' is distinct from 'pass'
      or exists (select 1 from jsonb_array_elements(review->'checks') item
        where item->>'verdict' is distinct from 'pass')) then
      raise exception 'First-aspect creative review must pass.'
        using errcode='23514'; end if;
    if p_verdict='rejected' and c.probe_result='pass'
      and (review is null or review->>'result' is distinct from 'fail') then
      raise exception 'A passing probe needs a failing creative review to reject.'
        using errcode='23514'; end if;
  else
    if p_creative_review is not null then
      raise exception 'Derivative review must inherit the first aspect.'
        using errcode='23514'; end if;
    if p_verdict='accepted' then
      select * into first_candidate from public.video_project_render_candidates_v1
        where project_id=p.id and ir_version=p.ir_version
          and aspect=p.aspects[1] and verdict='accepted';
      if first_candidate.id is null then
        raise exception 'First aspect must pass before derivatives.'
          using errcode='23514'; end if;
      review:=first_candidate.creative_review ||
        jsonb_build_object('inherited_from',first_candidate.id);
    else
      review:=null;
    end if;
  end if;
  if p_verdict='accepted' and c.probe_result is distinct from 'pass' then
    raise exception 'Media probe must pass before creative acceptance.'
      using errcode='23514'; end if;
  if c.verdict<>'pending' then
    if c.verdict is distinct from p_verdict
      or c.creative_review is distinct from review
      or c.rejection_reason is distinct from p_rejection_reason then
      raise exception 'Creative decision replay differs from receipt.'
        using errcode='23514'; end if;
    return c.id;
  end if;
  update public.video_project_render_candidates_v1
    set verdict=p_verdict,creative_review=review,
      rejection_reason=p_rejection_reason,reviewed_at=clock_timestamp()
    where id=c.id;
  return c.id;
end $$;
revoke all on function public.decide_video_project_render_candidate_v1(
  uuid,text,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.decide_video_project_render_candidate_v1(
  uuid,text,jsonb,text) to service_role;

-- Phase 3: a completed model run is a draft until a person checks its source.
-- Reviews keep the exact section bytes, model job and dated source. Editing or
-- rerunning the section changes its hash and makes the previous review stale.
begin;
alter table public.client_agent_records
  add constraint client_agent_records_id_client_unique_v7 unique(id,client_id);

create function public.model_section_snapshot_v7(p_record public.client_agent_records)
returns jsonb language sql stable set search_path=pg_catalog,public as $$
  select jsonb_build_object('record_id',p_record.id,'client_id',p_record.client_id,
    'domain',p_record.domain,'item_key',p_record.item_key,'title',p_record.title,
    'body',p_record.body,'model_job_id',p_record.job_id,
    'edited_at',p_record.edited_at,'edited_by',p_record.edited_by);
$$;
create function public.model_section_hash_v7(p_record public.client_agent_records)
returns text language sql stable set search_path=pg_catalog,public as $$
  select encode(sha256(convert_to(public.model_section_snapshot_v7(p_record)::text,'UTF8')),'hex');
$$;

create table public.model_section_reviews_v7 (
  id uuid primary key default gen_random_uuid(),
  review_order bigint generated always as identity unique,
  record_id uuid not null,
  client_id uuid not null,
  record_hash text not null check(record_hash ~ '^[0-9a-f]{64}$'),
  record_snapshot jsonb not null check(jsonb_typeof(record_snapshot)='object'),
  source_ref text not null check(length(btrim(source_ref)) between 1 and 2000),
  observed_on date not null check(observed_on<=current_date),
  confidence text not null check(confidence in ('supported','uncertain','unsupported')),
  review_note text not null default '' check(length(review_note)<=4000),
  reviewed_by uuid not null references public.profiles(id),
  reviewed_at timestamptz not null default now(),
  foreign key(record_id,client_id) references public.client_agent_records(id,client_id)
    on delete cascade
);
create index model_section_reviews_v7_latest
  on public.model_section_reviews_v7(record_id,review_order desc);
alter table public.model_section_reviews_v7 enable row level security;
create policy model_section_reviews_v7_read on public.model_section_reviews_v7
  for select to authenticated using(public.can_access_client(client_id));
revoke all on public.model_section_reviews_v7 from public,anon,authenticated;
grant select on public.model_section_reviews_v7 to authenticated,service_role;

create view public.model_section_review_state_v7 with (security_invoker=true) as
select r.id as record_id,r.client_id,r.domain,r.item_key,r.title,r.body,
  r.job_id as model_job_id,r.edited_at,r.updated_at,
  public.model_section_hash_v7(r) as record_hash,
  review.id as review_id,review.source_ref,review.observed_on,
  review.confidence,review.review_note,review.reviewed_by,review.reviewed_at,
  case when review.id is null then 'missing'
    when review.record_hash<>public.model_section_hash_v7(r) then 'stale'
    else review.confidence end as review_state
from public.client_agent_records r
left join lateral (select x.* from public.model_section_reviews_v7 x
  where x.record_id=r.id order by x.review_order desc limit 1) review on true
where r.archived_at is null;
revoke all on public.model_section_review_state_v7 from public,anon,authenticated;
grant select on public.model_section_review_state_v7 to authenticated,service_role;

create function public.review_model_section_v7(
  p_record_id uuid,p_source_ref text,p_observed_on date,
  p_confidence text,p_review_note text default ''
) returns public.model_section_reviews_v7 language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare r public.client_agent_records%rowtype;
  result public.model_section_reviews_v7%rowtype;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null then
    raise exception 'A provisioned human must review this model section.' using errcode='42501'; end if;
  select * into r from public.client_agent_records where id=p_record_id for share;
  if not found or not (coalesce(public.is_admin(),false) or
    coalesce(auth.uid()=public.active_video_approval_manager(r.client_id),false)) then
    raise exception 'The section or its review owner is unavailable.' using errcode='42501'; end if;
  if nullif(btrim(coalesce(r.body,'')),'') is null then
    raise exception 'A blank section cannot be reviewed.' using errcode='23514'; end if;
  if nullif(btrim(coalesce(p_source_ref,'')),'') is null
    or length(btrim(p_source_ref))>2000 or p_observed_on is null
    or p_observed_on>current_date or p_confidence not in ('supported','uncertain','unsupported')
    or p_confidence is null or length(coalesce(p_review_note,''))>4000 then
    raise exception 'Name a source, observation date, confidence and review note.'
      using errcode='23514'; end if;
  if p_confidence<>'supported' and nullif(btrim(coalesce(p_review_note,'')),'') is null then
    raise exception 'Explain an uncertain or unsupported section.' using errcode='23514'; end if;
  insert into public.model_section_reviews_v7
    (record_id,client_id,record_hash,record_snapshot,source_ref,observed_on,
      confidence,review_note,reviewed_by)
  values(r.id,r.client_id,public.model_section_hash_v7(r),
    public.model_section_snapshot_v7(r),btrim(p_source_ref),p_observed_on,
    p_confidence,btrim(coalesce(p_review_note,'')),auth.uid())
  returning * into result;
  return result;
end $$;
revoke all on function public.review_model_section_v7(uuid,text,date,text,text)
  from public,anon,service_role;
grant execute on function public.review_model_section_v7(uuid,text,date,text,text)
  to authenticated;

select public.lock_down_definer_functions();
commit;

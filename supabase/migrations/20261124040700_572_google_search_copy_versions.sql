-- Version Google search copy against one reviewed paid-route demand item.
-- This storage is deliberately inert until a dedicated producer, source-rights
-- check and exact review adapter connect it to the campaign sweep. It does not
-- change the legacy mutable google_ads_copy row or enable a Google Ads writer.
begin;

create unique index delivery_work_id_campaign_client_v7
  on public.delivery_work_items_v6(id,campaign_id,client_id);

create table public.campaign_google_search_copy_versions_v7 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  campaign_id uuid not null,
  route_package_id uuid not null,
  content_spec_id uuid not null,
  work_item_id uuid not null,
  piece_index integer not null check (piece_index > 0),
  source_idea_id uuid not null references public.client_ideas(id) on delete restrict,
  source_snapshot jsonb not null check (jsonb_typeof(source_snapshot)='object'),
  version integer not null check (version > 0),
  headlines text[] not null check (array_length(headlines,1) between 3 and 15
    and public.all_within_length(headlines,30)),
  descriptions text[] not null check (array_length(descriptions,1) between 2 and 4
    and public.all_within_length(descriptions,90)),
  rationale text not null check (length(btrim(rationale)) >= 20),
  copy_hash text not null check (copy_hash ~ '^[0-9a-f]{64}$'),
  producer_job_id uuid not null unique references public.agent_jobs(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (campaign_id,client_id) references public.client_campaigns(id,client_id)
    on delete restrict,
  foreign key (route_package_id,campaign_id,client_id)
    references public.campaign_route_packages_v6(id,campaign_id,client_id) on delete restrict,
  foreign key (content_spec_id,campaign_id,client_id)
    references public.campaign_content_spec_versions_v7(id,campaign_id,client_id) on delete restrict,
  foreign key (work_item_id,campaign_id,client_id)
    references public.delivery_work_items_v6(id,campaign_id,client_id) on delete restrict,
  unique (work_item_id,version)
);
create index campaign_google_search_copy_client_v7
  on public.campaign_google_search_copy_versions_v7
  (client_id,campaign_id,route_package_id,piece_index,version desc);
create trigger campaign_google_search_copy_immutable_v7 before update or delete
  on public.campaign_google_search_copy_versions_v7 for each row
  execute function public.reject_approval_ledger_mutation_v6();
alter table public.campaign_google_search_copy_versions_v7 enable row level security;
create policy campaign_google_search_copy_read_v7
  on public.campaign_google_search_copy_versions_v7 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.campaign_google_search_copy_versions_v7 from public,anon,authenticated;
grant select on public.campaign_google_search_copy_versions_v7 to authenticated;
grant all on public.campaign_google_search_copy_versions_v7 to service_role;

create function public.record_campaign_google_search_copy_v7(
  p_work_item_id uuid, p_source_idea_id uuid, p_job_id uuid,
  p_headlines text[], p_descriptions text[], p_rationale text
) returns public.campaign_google_search_copy_versions_v7
language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare w public.delivery_work_items_v6%rowtype;
  c public.client_campaigns%rowtype;
  route public.campaign_route_packages_v6%rowtype;
  spec public.campaign_content_spec_versions_v7%rowtype;
  idea public.client_ideas%rowtype;
  v_piece jsonb; v_source jsonb; v_hash text;
  v_prior public.campaign_google_search_copy_versions_v7%rowtype;
  v_position integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Google search copy requires the internal producer.' using errcode='42501';
  end if;
  select * into w from public.delivery_work_items_v6 where id=p_work_item_id;
  if w.id is null or w.owner_module<>'content_production_factory'
    or not w.required or w.route_key<>'paid'
    or w.item_key !~ '^content_piece[1-9][0-9]*$'
    or w.expected_output->>'platform' is distinct from 'google_ads'
    or w.expected_output->>'media_type' is distinct from 'text'
    or w.expected_output->>'content_format' is distinct from 'single' then
    raise exception 'A planned Google search-copy work item is required.' using errcode='23514';
  end if;
  v_position:=substring(w.item_key from '^content_piece([1-9][0-9]*)$')::integer;
  select * into c from public.client_campaigns where id=w.campaign_id
    and client_id=w.client_id for update;
  select * into route from public.campaign_route_packages_v6
    where id=w.route_package_id and campaign_id=c.id and client_id=c.client_id;
  select * into spec from public.campaign_content_spec_versions_v7
    where id=c.content_spec_id and campaign_id=c.id and client_id=c.client_id;
  if c.id is null or not c.runs_paid or c.paid_platform<>'google'
    or c.plan_approved_at is null
    or c.plan_approved_fingerprint is distinct from public.campaign_plan_fingerprint(c)
    or route.id is null or route.route<>'paid' or route.paid_platform<>'google'
    or route.plan_fingerprint is distinct from public.campaign_plan_fingerprint(c)
    or route.version is distinct from (select max(rp.version)
      from public.campaign_route_packages_v6 rp
      where rp.campaign_id=c.id and rp.route='paid')
    or spec.id is null or spec.content_hash is distinct from c.content_spec_hash
    or w.input_snapshot->>'content_spec_id' is distinct from spec.id::text
    or w.input_snapshot->>'content_spec_hash' is distinct from spec.content_hash
    or w.input_snapshot->>'route_package_id' is distinct from route.id::text
    or w.input_snapshot->>'piece_index' is distinct from v_position::text
    or w.input_snapshot->>'planned_idea_id' is distinct from p_source_idea_id::text
    or v_position>jsonb_array_length(spec.pieces) then
    raise exception 'Google search-copy route or plan is stale.' using errcode='23514';
  end if;
  v_piece:=spec.pieces->(v_position-1);
  if v_piece is distinct from jsonb_build_object('route','paid','platform','google_ads',
      'media_type','text','content_format','single')
    or w.input_snapshot->'piece' is distinct from v_piece then
    raise exception 'Google search-copy demand does not match the approved piece.'
      using errcode='23514';
  end if;
  select * into idea from public.client_ideas where id=p_source_idea_id
    and campaign_id=c.id and client_id=c.client_id and campaign_position=v_position;
  if idea.id is null or idea.archived_at is not null
    or idea.media_type::text<>'text' or idea.content_format::text<>'single'
    or idea.target_platform is not null or idea.acquisition_route<>'paid' then
    raise exception 'A current paid Google idea at the planned position is required.'
      using errcode='23514';
  end if;
  if not exists (select 1 from public.agent_jobs j where j.id=p_job_id
      and j.client_id=c.client_id and j.agent_key='google_search_copy'
      and j.input_table='client_ideas' and j.input_id=idea.id) then
    raise exception 'A matching Google copy producer job is required.' using errcode='23514';
  end if;
  if coalesce(array_length(p_headlines,1),0) not between 3 and 15
    or coalesce(array_length(p_descriptions,1),0) not between 2 and 4
    or not public.all_within_length(p_headlines,30)
    or not public.all_within_length(p_descriptions,90)
    or nullif(btrim(p_rationale),'') is null or length(btrim(p_rationale))<20
    or exists (select 1 from unnest(p_headlines) x where x<>btrim(x)
      or x ~ '[[:space:]]{2,}' or x ~ '[[:cntrl:]]')
    or exists (select 1 from unnest(p_descriptions) x where x<>btrim(x)
      or x ~ '[[:space:]]{2,}' or x ~ '[[:cntrl:]]')
    or (select count(*) from (select distinct lower(x) from unnest(p_headlines) x) d)
      <>array_length(p_headlines,1)
    or (select count(*) from (select distinct lower(x) from unnest(p_descriptions) x) d)
      <>array_length(p_descriptions,1) then
    raise exception 'Google search copy fails bounded review requirements.' using errcode='23514';
  end if;
  v_source:=jsonb_build_object('campaign_id',c.id,'client_id',c.client_id,
    'route_package_id',route.id,'route_version',route.version,
    'plan_fingerprint',route.plan_fingerprint,'content_spec_id',spec.id,
    'content_spec_hash',spec.content_hash,'piece_index',v_position,
    'idea_id',idea.id,'idea_title',idea.title,'idea_body',idea.body,
    'idea_source_question',idea.source_question,
    'idea_strategic_reason',idea.strategic_reason,
    'offer_version_id',c.offer_version_id);
  v_hash:=encode(sha256(convert_to(jsonb_build_object('source',v_source,
    'headlines',p_headlines,'descriptions',p_descriptions,
    'rationale',btrim(p_rationale))::text,'UTF8')),'hex');
  select * into v_prior from public.campaign_google_search_copy_versions_v7
    where producer_job_id=p_job_id;
  if v_prior.id is not null then
    if v_prior.work_item_id<>w.id or v_prior.source_idea_id<>idea.id
      or v_prior.copy_hash<>v_hash then
      raise exception 'Google copy job already recorded different bytes.' using errcode='23505';
    end if;
    return v_prior;
  end if;
  insert into public.campaign_google_search_copy_versions_v7
    (client_id,campaign_id,route_package_id,content_spec_id,work_item_id,
      piece_index,source_idea_id,source_snapshot,version,headlines,descriptions,
      rationale,copy_hash,producer_job_id)
  values (c.client_id,c.id,route.id,spec.id,w.id,v_position,idea.id,v_source,
    coalesce((select max(version)+1 from public.campaign_google_search_copy_versions_v7
      where work_item_id=w.id),1),p_headlines,p_descriptions,btrim(p_rationale),
    v_hash,p_job_id) returning * into v_prior;
  return v_prior;
end $$;
revoke all on function public.record_campaign_google_search_copy_v7(
  uuid,uuid,uuid,text[],text[],text) from public,anon,authenticated;
grant execute on function public.record_campaign_google_search_copy_v7(
  uuid,uuid,uuid,text[],text[],text) to service_role;

select public.lock_down_definer_functions();
commit;

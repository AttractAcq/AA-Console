-- A reviewed campaign plan names each content piece's route, destination and
-- format. The immutable spec prevents a sweep from inventing all-image work.
begin;

create table public.campaign_content_spec_versions_v7 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  campaign_id uuid not null,
  version integer not null check (version > 0),
  pieces jsonb not null check (jsonb_typeof(pieces)='array'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key(campaign_id,client_id) references public.client_campaigns(id,client_id) on delete restrict,
  unique(campaign_id,version),
  unique(id,campaign_id,client_id)
);
create index campaign_content_specs_client_v7
  on public.campaign_content_spec_versions_v7(client_id,campaign_id,version desc);
create trigger campaign_content_specs_append_only_v7
  before update or delete on public.campaign_content_spec_versions_v7
  for each row execute function public.reject_approval_ledger_mutation_v6();
alter table public.campaign_content_spec_versions_v7 enable row level security;
create policy campaign_content_specs_read_v7 on public.campaign_content_spec_versions_v7
  for select to authenticated using (public.can_access_client(client_id));
revoke all on public.campaign_content_spec_versions_v7 from public,anon,authenticated;
grant select on public.campaign_content_spec_versions_v7 to authenticated;
grant select,insert on public.campaign_content_spec_versions_v7 to service_role;

alter table public.client_campaigns
  add column content_spec_id uuid references public.campaign_content_spec_versions_v7(id) on delete restrict,
  add column content_spec_hash text check(content_spec_hash ~ '^[0-9a-f]{64}$'),
  add constraint client_campaign_content_spec_pair_v7 check
    ((content_spec_id is null)=(content_spec_hash is null));

create or replace function public.campaign_plan_fingerprint(p_campaign public.client_campaigns)
returns text language sql immutable set search_path=pg_catalog,public as $$
  select md5((jsonb_build_object(
    'objective', p_campaign.objective,
    'audience', p_campaign.audience,
    'offer_summary', p_campaign.offer_summary,
    'core_message', p_campaign.core_message,
    'channels', to_jsonb(coalesce(p_campaign.channels, array[]::text[])),
    'budget', p_campaign.budget,
    'starts_on', p_campaign.starts_on,
    'ends_on', p_campaign.ends_on,
    'kpi_metric', p_campaign.kpi_metric,
    'kpi_target', p_campaign.kpi_target,
    'content_count', p_campaign.content_count,
    'organic_content_count', p_campaign.organic_content_count,
    'paid_content_count', p_campaign.paid_content_count,
    'needs_landing_page', p_campaign.needs_landing_page,
    'needs_sales_agent', p_campaign.needs_sales_agent,
    'offer_version_id', p_campaign.offer_version_id)
    || case when p_campaign.content_spec_hash is null then '{}'::jsonb
      else jsonb_build_object('content_spec_hash',p_campaign.content_spec_hash) end)::text)
$$;

create function public.set_campaign_content_spec_v7(p_campaign_id uuid,p_pieces jsonb)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare c public.client_campaigns%rowtype; current public.campaign_content_spec_versions_v7%rowtype;
  piece jsonb; position integer := 0; organic_count integer := 0; paid_count integer := 0;
  route text; platform text; media text; format text; h text;
begin
  select * into c from public.client_campaigns where id=p_campaign_id for update;
  if c.id is null then raise exception 'Campaign unavailable.' using errcode='23514'; end if;
  if auth.role()<>'service_role' and (auth.role()<>'authenticated'
    or not public.can_access_client(c.client_id)) then
    raise exception 'Only the planner or client owner may set content requirements.' using errcode='42501'; end if;
  if c.acquisition_mode='legacy' or c.built_at is null
    or c.content_count<1 or p_pieces is null or jsonb_typeof(p_pieces)<>'array'
    or jsonb_array_length(p_pieces)<>c.content_count then
    raise exception 'A built route plan needs exactly its planned number of content pieces.'
      using errcode='23514'; end if;
  for piece in select value from jsonb_array_elements(p_pieces) loop
    position:=position+1;
    if jsonb_typeof(piece)<>'object' or exists(
      select 1 from jsonb_object_keys(piece) key
      where key not in ('route','platform','media_type','content_format')) then
      raise exception 'Content piece % has unknown fields.',position using errcode='23514'; end if;
    route:=piece->>'route'; platform:=piece->>'platform';
    media:=piece->>'media_type'; format:=piece->>'content_format';
    if route is null or platform is null or media is null or format is null
      or route not in ('organic','paid') or media not in ('image','text','video')
      or format not in ('single','carousel','story','reel')
      or (format='carousel' and media<>'image')
      or (format='story' and media='text')
      or (format='reel' and media<>'video')
      or (route='organic' and not c.runs_organic)
      or (route='paid' and not c.runs_paid)
      or (route='organic' and platform not in ('instagram','facebook','tiktok','linkedin','youtube'))
      or (platform='tiktok' and format='story')
      or (platform='linkedin' and format in ('story','reel'))
      or (platform='youtube' and format in ('carousel','story'))
      or (route='paid' and c.paid_platform='meta'
        and platform not in ('instagram','facebook'))
      or (route='paid' and c.paid_platform='google'
        and (platform<>'google_ads' or media<>'text' or format<>'single'))
      then
      raise exception 'Content piece % has an invalid route, destination or format.',position
        using errcode='23514'; end if;
    if route='organic' then organic_count:=organic_count+1;
      else paid_count:=paid_count+1; end if;
  end loop;
  if organic_count<>c.organic_content_count or paid_count<>c.paid_content_count then
    raise exception 'Content pieces must match the approved route volumes.' using errcode='23514'; end if;
  h:=encode(sha256(convert_to(p_pieces::text,'UTF8')),'hex');
  if c.content_spec_hash=h and c.content_spec_id is not null then return c.content_spec_id; end if;
  insert into public.campaign_content_spec_versions_v7
    (client_id,campaign_id,version,pieces,content_hash,created_by)
  values(c.client_id,c.id,coalesce((select max(version)+1 from public.campaign_content_spec_versions_v7
    where campaign_id=c.id),1),p_pieces,h,auth.uid()) returning * into current;
  update public.client_campaigns set content_spec_id=current.id,content_spec_hash=h,
    plan_approved_at=null,plan_approved_by=null,plan_approved_fingerprint=null,
    updated_at=now() where id=c.id;
  return current.id;
end $$;
revoke all on function public.set_campaign_content_spec_v7(uuid,jsonb)
  from public,anon;
grant execute on function public.set_campaign_content_spec_v7(uuid,jsonb)
  to authenticated,service_role;

create or replace function public.approve_campaign_plan_v6(p_campaign_id uuid,p_note text default null)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.client_campaigns%rowtype; v_fingerprint text;
begin
  select * into c from public.client_campaigns where id=p_campaign_id for update;
  if c.id is null then raise exception 'That campaign no longer exists.' using errcode='P0001'; end if;
  if auth.role()<>'authenticated' or not public.can_access_client(c.client_id) then
    raise exception 'Only a person with access to this client can approve its plan.' using errcode='P0001'; end if;
  if c.built_at is null then
    raise exception 'This campaign has no plan yet. There is nothing to approve.' using errcode='P0001'; end if;
  if c.acquisition_mode<>'legacy' and c.content_count>0 and (c.content_spec_id is null
    or c.content_spec_hash is null or not exists(
      select 1 from public.campaign_content_spec_versions_v7 s
      where s.id=c.content_spec_id and s.campaign_id=c.id and s.client_id=c.client_id
        and s.content_hash=c.content_spec_hash)) then
    raise exception 'Review a complete route and format specification before approving this plan.'
      using errcode='23514'; end if;
  v_fingerprint:=public.campaign_plan_fingerprint(c);
  if c.plan_approved_at is not null and c.plan_approved_fingerprint=v_fingerprint then
    raise exception 'This exact plan is already approved.' using errcode='P0001'; end if;
  update public.client_campaigns set plan_approved_at=now(),plan_approved_by=auth.uid(),
    plan_approved_fingerprint=v_fingerprint,plan_review_note=nullif(btrim(p_note),''),
    updated_at=now() where id=c.id;
end $$;

commit;

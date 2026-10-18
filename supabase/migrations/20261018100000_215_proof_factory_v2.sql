-- Additive v2 workspace. Existing v1 proof types and uploads are preserved.
alter table public.client_proof_assets
  add column capture_method text,
  add column source_category text,
  add column source_kind text,
  add column source_format public.content_format not null default 'single';
alter table public.client_proof_assets
  add constraint proof_capture_method_v2 check (capture_method in ('automated_requests','field_capture','guided_interview','integration','manual_import','outcome_followup')),
  add constraint proof_category_v2 check (source_category in ('customers','business_operations','independent_sources'));

alter table public.client_proof_assets add constraint proof_source_kind_v2 check (
  (source_category is null and source_kind is null) or
  (source_category is not null and source_kind is not null and (
  (source_category = 'customers' and source_kind is not null and source_kind in ('Video Testimonials','Online Reviews','Customer Feedback Forms','Customer-Submitted Photos & Videos','Referral & Recommendation Capture','Customer Interviews')) or
  (source_category = 'business_operations' and source_kind is not null and source_kind in ('Before-and-after Documentation','Proof of Work Capture','Employee Voice Notes / Field Reports','Job Completion Forms','Measured Result Capture','Historical Project Import')) or
  (source_category = 'independent_sources' and source_kind is not null and source_kind in ('Certification & Accreditations','Independent Inspection & Verification','Media Mentions & External Recognition','Organic Mentions and Social Listening','Partners and Supplier Endorsements','Customer Outcome Follow-ups'))
  ))
);

create table public.proof_capture_configs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  method text not null check (method in ('automated_requests','field_capture','guided_interview','manual_import')),
  name text not null check (length(btrim(name)) between 1 and 200),
  instructions text not null default '' check (length(instructions) <= 20000),
  trigger_event text,
  message_template text,
  page_id uuid references public.client_pages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.proof_capture_configs enable row level security;
create policy proof_capture_read on public.proof_capture_configs for select to authenticated
  using (public.can_access_client(client_id));
create policy proof_capture_write on public.proof_capture_configs for all to authenticated
  using (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id))
  with check (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
create function public.check_proof_capture_config_v2() returns trigger language plpgsql
set search_path=pg_catalog,public as $$ begin
  if TG_OP='UPDATE' and new.client_id <> old.client_id then raise exception 'Cannot move capture settings between clients.'; end if;
  if new.page_id is not null and not exists (select 1 from public.client_pages where id=new.page_id and client_id=new.client_id) then
    raise exception 'Choose a page belonging to this client.';
  end if;
  new.updated_at := now(); return new;
end $$;
create trigger proof_capture_validate before insert or update on public.proof_capture_configs
for each row execute function public.check_proof_capture_config_v2();
grant select,insert,update,delete on public.proof_capture_configs to authenticated;
grant all on public.proof_capture_configs to service_role;

create table public.proof_production_requests (
  id uuid primary key,
  client_id uuid not null references public.clients(id) on delete cascade,
  source_proof_id uuid not null references public.client_proof_assets(id) on delete restrict,
  source_asset_id uuid references public.client_media_assets(id) on delete restrict,
  idea_id uuid not null unique references public.client_ideas(id) on delete restrict,
  job_id uuid references public.agent_jobs(id) on delete set null,
  direction text not null,
  destination text not null,
  created_at timestamptz not null default now()
);
alter table public.proof_production_requests enable row level security;
create policy proof_production_read on public.proof_production_requests for select to authenticated
using (public.can_access_client(client_id));
grant select on public.proof_production_requests to authenticated;
grant all on public.proof_production_requests to service_role;

create function public.request_proof_production_v2(
 p_request_id uuid, p_client_id uuid, p_source_proof_id uuid,
 p_source_asset_id uuid, p_media_type public.media_type, p_format public.content_format,
 p_direction text, p_destination text
) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.client_proof_assets%rowtype; r public.proof_production_requests%rowtype;
 v_idea uuid; v_job uuid; v_parent_proof uuid; v_parent_body text;
begin
 if auth.role() is distinct from 'authenticated' or not (coalesce(public.is_admin(),false)
   or coalesce(auth.uid()=public.active_video_approval_manager(p_client_id),false)) then
   raise exception 'Only an admin or assigned client manager can produce proof.';
 end if;
 if p_request_id is null then raise exception 'A request ID is required.'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 select * into r from public.proof_production_requests where id=p_request_id;
 if found then
   if r.client_id<>p_client_id then raise exception 'Request belongs to another client.'; end if;
   if r.source_proof_id is distinct from p_source_proof_id or r.source_asset_id is distinct from p_source_asset_id
     or r.direction is distinct from p_direction or r.destination is distinct from p_destination
     or not exists(select 1 from public.client_ideas where id=r.idea_id and media_type=p_media_type and content_format=p_format) then
     raise exception 'Request ID already used with different instructions.';
   end if;
   return r.id;
 end if;
 select * into p from public.client_proof_assets where id=p_source_proof_id and client_id=p_client_id;
 if not found or p.usage_rights <> 'approved' or (p.expires_on is not null and p.expires_on<current_date)
   or nullif(btrim(p.permission_basis),'') is null then raise exception 'Clear this proof and record permission before production.'; end if;
 if coalesce(nullif(btrim(p.evidence),''),nullif(btrim(p.body),'')) is null then
   raise exception 'Add an evidence description or transcript to the proof before production.';
 end if;
 if p_media_type is null or p_format is null or p_direction is null or length(btrim(p_direction)) not between 1 and 10000 then raise exception 'Choose an output and provide production instructions.'; end if;
 if (p_format='carousel' and p_media_type<>'image') or (p_format='reel' and p_media_type<>'video') or (p_media_type='text' and p_format<>'single') then raise exception 'Unsupported media and format combination.'; end if;
 if p_destination is null or p_destination not in ('Main Website','SEO / GEO Content','Google Business Profile','Organic Social Media','Paid Advertising','Campaign Landing Pages','Sales Conversations','Email / SMS Nurturing','Third Party Directories','Proposals & Quotations') then raise exception 'Choose a distribution destination.'; end if;
 if p_source_asset_id is not null then
   select b.proof_asset_id,b.body into v_parent_proof,v_parent_body from public.client_media_assets a
   join public.client_briefs b on b.id=a.brief_id and b.client_id=a.client_id
   where a.id=p_source_asset_id and a.client_id=p_client_id and a.review_status='approved';
   if v_parent_proof is distinct from p_source_proof_id then raise exception 'Choose an approved asset derived from this proof.'; end if;
 end if;
 insert into public.client_ideas(client_id,title,body,media_type,content_format,source,proof_id,created_by,status,content_territory)
 values(p_client_id, left(coalesce(p.title,'Proof')||' · '||p_format::text,300),
 'Produce only from this genuine evidence. Never invent results, quotes or customer endorsements.'||E'\nEvidence: '||coalesce(nullif(btrim(p.evidence),''),p.body)||E'\nDestination: '||p_destination||E'\nInstructions: '||p_direction||coalesce(E'\nApproved parent asset brief (adapt its argument without inventing claims): '||v_parent_body,''),
 p_media_type,p_format,'proof',p.id,auth.uid(),'approved','Proof Production Factory') returning id into v_idea;
 v_job:=public.enqueue_agent_job_internal('brief',p_client_id,'client_ideas',v_idea,auth.uid(),
   jsonb_build_object('proof_factory_source_id',p.id),'Queued proof production brief');
 insert into public.proof_production_requests(id,client_id,source_proof_id,source_asset_id,idea_id,job_id,direction,destination)
 values(p_request_id,p_client_id,p.id,p_source_asset_id,v_idea,v_job,p_direction,p_destination);
 update public.client_ideas set status='briefed',job_id=v_job where id=v_idea;
 return p_request_id;
end $$;
revoke all on function public.request_proof_production_v2(uuid,uuid,uuid,uuid,public.media_type,public.content_format,text,text) from public,anon;
grant execute on function public.request_proof_production_v2(uuid,uuid,uuid,uuid,public.media_type,public.content_format,text,text) to authenticated;

create function public.bind_proof_production_brief_v2() returns trigger language plpgsql
security definer set search_path=pg_catalog,public as $$
declare r public.proof_production_requests%rowtype;
begin
 if TG_OP='UPDATE' and new.source_idea_id is distinct from old.source_idea_id
   and exists(select 1 from public.proof_production_requests where idea_id=old.source_idea_id) then
   raise exception 'A proof production brief cannot detach from its source request.';
 end if;
 select * into r from public.proof_production_requests where idea_id=new.source_idea_id;
 if found then
   if new.client_id<>r.client_id or new.proof_asset_id is distinct from r.source_proof_id then
     raise exception 'Proof production must retain the selected evidence source.';
   end if;
   new.derived_from_asset_id:=r.source_asset_id;
 end if;
 return new;
end $$;
create trigger proof_production_brief_binding before insert or update on public.client_briefs
for each row execute function public.bind_proof_production_brief_v2();

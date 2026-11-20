-- Human AAL2 resolution of a held returning submission. The reviewed packet
-- binds exact submitted source/consent and the untouched archived snapshot.
begin;
create table public.lead_return_resolutions_v11 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  submission_id uuid not null unique references public.lead_submissions(id)
    on delete restrict,
  archived_lead_id uuid not null,
  resolved_lead_id uuid not null,
  action text not null check (action in ('recover','new_lead')),
  reason text not null check (length(btrim(reason)) between 8 and 2000),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  reviewer_id uuid not null references auth.users(id) on delete restrict,
  reviewer_aal text not null check (reviewer_aal='aal2'),
  reviewed_at timestamptz not null default clock_timestamp(),
  foreign key (archived_lead_id,client_id)
    references public.lead_identities(id,client_id) on delete restrict,
  foreign key (resolved_lead_id,client_id)
    references public.lead_identities(id,client_id) on delete restrict
);
alter table public.lead_return_resolutions_v11 enable row level security;
create policy lead_return_resolutions_read_v11
  on public.lead_return_resolutions_v11 for select to authenticated
  using (public.can_read_client_sales_data(client_id));
revoke all on public.lead_return_resolutions_v11
  from public,anon,authenticated,service_role;
grant select on public.lead_return_resolutions_v11 to authenticated;

create function public.guard_lead_return_resolution_history_v11()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  raise exception 'A reviewed lead return decision is immutable.'
    using errcode='23514';
end $$;
revoke all on function public.guard_lead_return_resolution_history_v11()
  from public,anon,authenticated,service_role;
create trigger lead_return_resolution_immutable_v11
  before update or delete on public.lead_return_resolutions_v11
  for each row execute function public.guard_lead_return_resolution_history_v11();

create function public.archived_return_review_packet_v11(p_submission_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare s public.lead_submissions%rowtype;
  a public.archived_leads%rowtype; v_hash text;
begin
  if auth.role() not in ('authenticated','service_role') then
    raise exception 'A signed-in lead reviewer is required.' using errcode='42501';
  end if;
  select * into s from public.lead_submissions where id=p_submission_id;
  if s.id is null or not public.may_manage_client_leads(s.client_id) then
    raise exception 'Not permitted for this client.' using errcode='42501';
  end if;
  if s.status<>'received' or s.lead_id is not null
     or s.archive_match_lead_id is null then
    raise exception 'This submission is not waiting for archived-lead review.'
      using errcode='23514';
  end if;
  select * into a from public.archived_leads
    where id=s.archive_match_lead_id and client_id=s.client_id;
  if a.id is null then
    raise exception 'The archived lead changed; review again.' using errcode='23514';
  end if;
  v_hash:=encode(sha256(convert_to(jsonb_build_object(
    'submission',to_jsonb(s),'archive',to_jsonb(a))::text,'UTF8')),'hex');
  return jsonb_build_object(
    'source_hash',v_hash,'submission_id',s.id,'client_id',s.client_id,
    'archived_lead_id',a.id,'archived_name',a.name,
    'archived_stage',a.stage_at_archive,'archived_at',a.archived_at,
    'archived_email',a.lead->>'email','archived_phone',a.lead->>'phone',
    'archived_source',a.lead->>'source',
    'submitted_name',s.name,'submitted_email',s.email,
    'submitted_phone',s.phone,'submitted_at',s.created_at,
    'consent_wording',s.consent_wording,
    'consent_given_at',s.consent_given_at,
    'source_snapshot',s.consent_evidence->'source_snapshot',
    'route_package_id',s.route_package_id,
    'click_id',s.click_id,'utm',s.utm);
end $$;
revoke all on function public.archived_return_review_packet_v11(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.archived_return_review_packet_v11(uuid)
  to authenticated,service_role;

create function public.resolve_archived_return_v11(
  p_submission_id uuid,p_action text,p_expected_hash text,p_reason text)
returns uuid language plpgsql security definer
set search_path=pg_catalog,public as $$
declare s public.lead_submissions%rowtype;
  a public.archived_leads%rowtype; v_packet jsonb;
  v_dedupe text; v_resolved uuid; v_source jsonb;
begin
  if auth.role()<>'authenticated' or auth.uid() is null
     or coalesce(auth.jwt()->>'aal','')<>'aal2' then
    raise exception 'A signed-in AAL2 lead reviewer is required.'
      using errcode='42501';
  end if;
  if p_action not in ('recover','new_lead')
     or length(btrim(coalesce(p_reason,''))) not between 8 and 2000
     or p_expected_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Choose an exact action and give a review reason.'
      using errcode='23514';
  end if;
  select * into s from public.lead_submissions
    where id=p_submission_id for update;
  if s.id is null or not public.may_manage_client_leads(s.client_id) then
    raise exception 'Not permitted for this client.' using errcode='42501';
  end if;
  if s.status<>'received' or s.lead_id is not null
     or s.archive_match_lead_id is null
     or exists(select 1 from public.lead_return_resolutions_v11
       where submission_id=s.id) then
    raise exception 'This return has already been resolved or is not reviewable.'
      using errcode='23514';
  end if;
  v_dedupe:=public.lead_dedupe_key(s.email,s.phone);
  if v_dedupe is null then
    raise exception 'The submitted contact cannot be matched.'
      using errcode='23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    s.client_id::text || ':lead-contact:' || v_dedupe,0));
  select * into a from public.archived_leads
    where id=s.archive_match_lead_id and client_id=s.client_id for update;
  if a.id is null or coalesce(a.lead->>'dedupe_key',
       public.lead_dedupe_key(a.lead->>'email',a.lead->>'phone'))
       is distinct from v_dedupe
     or (select count(*) from public.archived_leads x
       where x.client_id=s.client_id and coalesce(x.lead->>'dedupe_key',
         public.lead_dedupe_key(x.lead->>'email',x.lead->>'phone'))=v_dedupe)<>1
     or exists(select 1 from public.client_leads l
       where l.client_id=s.client_id and l.dedupe_key=v_dedupe) then
    raise exception 'The contact match changed or is ambiguous; review again.'
      using errcode='23514';
  end if;
  v_packet:=public.archived_return_review_packet_v11(s.id);
  if v_packet->>'source_hash' is distinct from p_expected_hash then
    raise exception 'The reviewed submission or archive snapshot changed.'
      using errcode='23514';
  end if;
  if s.consent_given_at is null or nullif(btrim(s.consent_wording),'') is null then
    raise exception 'Consent evidence is missing.' using errcode='23514';
  end if;
  if p_action='recover' then
    v_resolved:=a.id;
    insert into public.lead_return_resolutions_v11(
      client_id,submission_id,archived_lead_id,resolved_lead_id,
      action,reason,source_hash,reviewer_id,reviewer_aal)
    values(s.client_id,s.id,a.id,v_resolved,p_action,btrim(p_reason),
      p_expected_hash,auth.uid(),'aal2');
    perform public.recover_lead(a.id);
  else
    v_source:=s.consent_evidence->'source_snapshot';
    if v_source is null or jsonb_typeof(v_source)<>'object'
       or nullif(v_source->>'purpose','') is null then
      raise exception 'Captured source snapshot is missing; review manually.'
        using errcode='23514';
    end if;
    insert into public.client_leads(
      client_id,name,email,phone,contact,notes,source,source_channel,
      consent_given_at,consent_wording,consent_evidence,
      source_client_campaign_id,source_page_id,source_click_id,source_utm,
      created_by)
    values(s.client_id,s.name,s.email,s.phone,coalesce(s.email,s.phone),
      s.message,v_source->>'purpose',
      coalesce(v_source->>'source_channel',v_source->>'purpose'),
      s.consent_given_at,s.consent_wording,s.consent_evidence,
      nullif(v_source->>'campaign_id','')::uuid,
      nullif(v_source->>'page_id','')::uuid,s.click_id,s.utm,auth.uid())
    returning id into v_resolved;
    insert into public.lead_return_resolutions_v11(
      client_id,submission_id,archived_lead_id,resolved_lead_id,
      action,reason,source_hash,reviewer_id,reviewer_aal)
    values(s.client_id,s.id,a.id,v_resolved,p_action,btrim(p_reason),
      p_expected_hash,auth.uid(),'aal2');
  end if;
  update public.lead_submissions set status='promoted',lead_id=v_resolved
    where id=s.id;
  insert into public.lead_events(lead_id,client_id,kind,body,created_by)
  values(v_resolved,s.client_id,'note',
    'Reviewed returning submission '||s.id::text||
    case p_action when 'recover' then ' reopened the archived lead.'
      else ' started a separate lead.' end,auth.uid());
  return v_resolved;
end $$;
revoke all on function public.resolve_archived_return_v11(uuid,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.resolve_archived_return_v11(uuid,text,text,text)
  to authenticated;
select public.lock_down_definer_functions();
commit;

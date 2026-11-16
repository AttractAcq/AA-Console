-- Outcome follow-up uses a real sales outcome and separate evidence of consent
-- to contact this person for proof. Intake consent alone is insufficient.
begin;

alter table public.proof_capture_configs drop constraint proof_capture_configs_method_check;
alter table public.proof_capture_configs add constraint proof_capture_configs_method_check
  check (method in ('automated_requests','field_capture','guided_interview',
    'manual_import','outcome_followup'));

create table public.proof_outcome_followup_consents_v7 (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  lead_id uuid not null references public.client_leads(id) on delete restrict,
  channel text not null check (channel in ('email','sms','whatsapp')),
  recipient text not null check (length(btrim(recipient)) between 3 and 320),
  consent_text text not null check (length(btrim(consent_text)) between 10 and 2000),
  evidence_note text not null check (length(btrim(evidence_note)) between 10 and 2000),
  evidence_url text,
  consented_at timestamptz not null,
  recorded_by uuid not null references public.profiles(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  withdrawal_reason text,
  unique (id,client_id,lead_id)
);
create unique index proof_outcome_active_consent_v7
  on public.proof_outcome_followup_consents_v7(lead_id,channel,recipient)
  where withdrawn_at is null;
create index proof_outcome_consent_client_v7
  on public.proof_outcome_followup_consents_v7(client_id,lead_id,recorded_at desc);
alter table public.proof_outcome_followup_consents_v7 enable row level security;
create policy proof_outcome_consent_read_v7
  on public.proof_outcome_followup_consents_v7 for select to authenticated
  using (public.is_admin() or auth.uid()=public.active_video_approval_manager(client_id));
create policy proof_outcome_consent_insert_v7
  on public.proof_outcome_followup_consents_v7 for insert to authenticated
  with check (public.is_admin() or auth.uid()=public.active_video_approval_manager(client_id));
create policy proof_outcome_consent_update_v7
  on public.proof_outcome_followup_consents_v7 for update to authenticated
  using (public.is_admin() or auth.uid()=public.active_video_approval_manager(client_id))
  with check (public.is_admin() or auth.uid()=public.active_video_approval_manager(client_id));
revoke all on public.proof_outcome_followup_consents_v7 from public,anon,authenticated;
grant select,insert,update on public.proof_outcome_followup_consents_v7 to authenticated;
grant select on public.proof_outcome_followup_consents_v7 to service_role;

create function public.guard_proof_outcome_consent_v7()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare l public.client_leads%rowtype;
begin
  if tg_op='UPDATE' then
    if (to_jsonb(new)-'withdrawn_at'-'withdrawal_reason')
       is distinct from (to_jsonb(old)-'withdrawn_at'-'withdrawal_reason')
       or old.withdrawn_at is not null or new.withdrawn_at is null
       or new.withdrawn_at<old.recorded_at or new.withdrawn_at>now()
       or nullif(btrim(coalesce(new.withdrawal_reason,'')),'') is null then
      raise exception 'Consent evidence is immutable; record a withdrawal or a new grant.'
        using errcode='23514';
    end if;
    return new;
  end if;
  if auth.role()<>'authenticated' or auth.uid() is null
     or new.recorded_by is distinct from auth.uid()
     or new.consented_at>now() or new.consented_at<now()-interval '2 years'
     or new.withdrawn_at is not null then
    raise exception 'Record a current consent from the signed-in decision owner.'
      using errcode='23514';
  end if;
  select * into l from public.client_leads where id=new.lead_id and client_id=new.client_id;
  if l.id is null or l.stage not in ('sale','cash')
     or (new.channel='email' and lower(btrim(new.recipient))
       is distinct from lower(btrim(coalesce(l.email,''))))
     or (new.channel in ('sms','whatsapp') and btrim(new.recipient)
       is distinct from btrim(coalesce(l.phone,''))) then
    raise exception 'Consent must match a recorded sale and the lead contact.'
      using errcode='23514';
  end if;
  return new;
end $$;
create trigger proof_outcome_consent_guard_v7 before insert or update
  on public.proof_outcome_followup_consents_v7 for each row
  execute function public.guard_proof_outcome_consent_v7();

alter table public.proof_request_deliveries
  add column outcome_lead_id uuid references public.client_leads(id) on delete restrict,
  add column outcome_consent_id uuid references public.proof_outcome_followup_consents_v7(id) on delete restrict,
  add constraint proof_delivery_outcome_pair_v7 check
    ((outcome_lead_id is null)=(outcome_consent_id is null));

create function public.proof_outcome_followup_ready_v7(d public.proof_request_deliveries)
returns boolean language sql stable security definer
set search_path=pg_catalog,public as $$
  select d.outcome_lead_id is not null and exists (
    select 1 from public.proof_outcome_followup_consents_v7 c
    join public.client_leads l on l.id=c.lead_id and l.client_id=c.client_id
    join public.proof_capture_configs config on config.id=d.config_id
      and config.client_id=d.client_id and config.method='outcome_followup'
    where c.id=d.outcome_consent_id and c.client_id=d.client_id
      and c.lead_id=d.outcome_lead_id and c.withdrawn_at is null
      and l.stage in ('sale','cash')
      and c.channel=d.channel and c.recipient=d.recipient
      and ((d.channel='email' and lower(btrim(l.email))=lower(btrim(d.recipient)))
        or (d.channel in ('sms','whatsapp') and btrim(l.phone)=btrim(d.recipient)))
      and (config.trigger_event is null or config.trigger_event=l.stage::text));
$$;

create function public.guard_proof_outcome_delivery_v7()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare method text;
begin
  select c.method into method from public.proof_capture_configs c
    where c.id=new.config_id and c.client_id=new.client_id;
  if method='outcome_followup' then
    if not public.proof_outcome_followup_ready_v7(new) then
      raise exception 'Outcome request needs a current sale, contact and separate proof follow-up consent.'
        using errcode='23514';
    end if;
  elsif new.outcome_lead_id is not null or new.outcome_consent_id is not null then
    raise exception 'Only outcome follow-up may bind a lead and consent.' using errcode='23514';
  end if;
  return new;
end $$;
create trigger proof_outcome_delivery_guard_v7 before insert or update of
  client_id,config_id,recipient,channel,outcome_lead_id,outcome_consent_id
  on public.proof_request_deliveries for each row
  execute function public.guard_proof_outcome_delivery_v7();

create or replace function public.proof_delivery_preview_v6(q public.proof_delivery_reviews_v6)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('client_id',d.client_id,'delivery_id',d.id,
 'request_token',q.request_token,'config_id',d.config_id,'link_id',d.link_id,
 'channel',d.channel,'recipient',d.recipient,'subject',d.subject,
 'message',d.message,'capture_url',d.capture_url,
 'template_sid',d.template_sid,'template_variables',d.template_variables,
 'scheduled_at',d.scheduled_at,'link_expires_at',l.expires_at,
 'link_revoked_at',l.revoked_at,'link_submissions',l.submissions,
 'link_max_submissions',l.max_submissions,
 'consequence','Send this exact proof request to this recipient through the configured provider')
 || case when d.outcome_lead_id is null then '{}'::jsonb else jsonb_build_object(
 'outcome_lead_id',d.outcome_lead_id,'outcome_consent_id',d.outcome_consent_id,
 'outcome_stage',lead.stage,'outcome_stage_at',lead.stage_at,
 'outcome_sale_value',lead.sale_value,'outcome_cash_collected',lead.cash_collected,
 'outcome_consent_text',consent.consent_text,
 'outcome_consent_evidence',consent.evidence_note,
 'outcome_consented_at',consent.consented_at,
 'outcome_consent_withdrawn_at',consent.withdrawn_at,
 'outcome_ready',public.proof_outcome_followup_ready_v7(d)) end
 from public.proof_request_deliveries d
 join public.proof_capture_links l on l.id=d.link_id and l.client_id=d.client_id and l.config_id=d.config_id
 join public.proof_capture_configs c on c.id=d.config_id and c.client_id=d.client_id
 left join public.client_leads lead on lead.id=d.outcome_lead_id and lead.client_id=d.client_id
 left join public.proof_outcome_followup_consents_v7 consent on consent.id=d.outcome_consent_id
   and consent.client_id=d.client_id and consent.lead_id=d.outcome_lead_id
 where d.id=q.delivery_id and d.client_id=q.client_id;
$$;

create or replace function public.proof_delivery_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare r public.approval_requests_v6%rowtype; q public.proof_delivery_reviews_v6%rowtype;
 d public.proof_request_deliveries%rowtype; l public.proof_capture_links%rowtype; h text;
begin
 select * into r from public.approval_requests_v6 where id=p_request_id;
 if r.id is null or r.source_system<>'aa_console' or r.source_kind<>'proof_delivery'
  or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then return 'unverified'; end if;
 if auth.role() is distinct from 'service_role' and
  (auth.role() is distinct from 'authenticated' or not public.can_review_approval_request_v6(r.client_id,r.owner_role))
  then return 'unverified'; end if;
 select * into q from public.proof_delivery_reviews_v6 where id=r.source_id::uuid
  and canonical_request_id=r.id and client_id=r.client_id;
 if q.id is null then return 'cancelled'; end if;
 if exists(select 1 from public.proof_delivery_reviews_v6 newer
  where newer.delivery_id=q.delivery_id and newer.review_epoch>q.review_epoch)
  then return 'superseded'; end if;
 select * into d from public.proof_request_deliveries where id=q.delivery_id and client_id=q.client_id;
 if d.id is null then return 'cancelled'; end if;
 select * into l from public.proof_capture_links where id=d.link_id and client_id=d.client_id and config_id=d.config_id;
 h:=public.proof_delivery_hash_v6(q);
 if h is null or q.source_hash is distinct from h or r.artifact_hash is distinct from h
  or r.source_version is distinct from h||':'||q.request_token::text
  or r.preview is distinct from public.proof_delivery_preview_v6(q)
  or r.scope is distinct from public.proof_delivery_scope_v6(q)
  or r.destination is distinct from d.channel||':'||d.recipient
  then return 'superseded'; end if;
 if d.status='cancelled' then return 'cancelled'; end if;
 if d.outcome_lead_id is not null and not public.proof_outcome_followup_ready_v7(d)
  then return 'source_held'; end if;
 if l.id is null or l.revoked_at is not null or l.expires_at<=now()
  or l.submissions>=l.max_submissions or d.recipient=''
  or d.message='' or d.capture_url='' or d.channel not in ('email','sms','whatsapp')
  then return 'source_held'; end if;
 if d.status in ('approved','sending','sent','uncertain') then return 'source_decided'; end if;
 if d.status not in ('pending_approval','failed') then return 'source_held'; end if;
 return 'pending';
end $$;

create view public.proof_outcome_followup_submissions_v7
with (security_barrier=true) as
select d.client_id,d.outcome_lead_id as lead_id,d.id as delivery_id,
  s.id as submission_id,s.proof_id,s.created_at as submitted_at
from public.proof_request_deliveries d
join public.proof_capture_submissions s on s.link_id=d.link_id and s.client_id=d.client_id
where d.outcome_lead_id is not null and public.can_access_client(d.client_id);
revoke all on public.proof_outcome_followup_submissions_v7 from public,anon,authenticated;
grant select on public.proof_outcome_followup_submissions_v7 to authenticated;

revoke all on function public.guard_proof_outcome_consent_v7() from public,anon,authenticated,service_role;
revoke all on function public.proof_outcome_followup_ready_v7(public.proof_request_deliveries)
  from public,anon,authenticated,service_role;
revoke all on function public.guard_proof_outcome_delivery_v7() from public,anon,authenticated,service_role;
commit;

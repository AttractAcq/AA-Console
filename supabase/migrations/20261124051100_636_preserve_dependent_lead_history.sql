-- Preserve dependent lead history when the active row is archived. The durable
-- identity key is same-client; writes still require an active lead. Cash-positive
-- archiving remains held until the coordinated cross-surface gate passes.
begin;
do $preflight$
declare v_item record; v_bad boolean;
begin
  for v_item in select * from (values
    ('campaign_lead_enrolment_items_v6','lead_id'),
    ('campaign_page_publications','probe_lead_id'),
    ('client_appointments','lead_id'),
    ('dm_conversations','lead_id'),
    ('dm_identities','lead_id'),
    ('lead_magnet_deliveries','lead_id'),
    ('lead_sequence_enrollments','lead_id'),
    ('outbound_messages','lead_id'),
    ('proof_outcome_followup_consents_v7','lead_id'),
    ('proof_request_deliveries','outcome_lead_id'),
    ('proof_service_outcomes_v7','lead_id')
  ) as t(table_name,lead_column) loop
    execute format(
      'select exists (select 1 from public.%I d left join public.lead_identities i '
      || 'on i.id=d.%I and i.client_id=d.client_id '
      || 'where d.%I is not null and i.id is null)',
      v_item.table_name,v_item.lead_column,v_item.lead_column) into v_bad;
    if v_bad then
      raise exception 'Dependent % has a lead without a same-client durable identity.',
        v_item.table_name using errcode='23503';
    end if;
  end loop;
  if exists (
    select 1 from public.workflow_lead_attribution a
    join public.workflow_runs r on r.id=a.run_id
    left join public.lead_identities i
      on i.id=a.lead_id and i.client_id=r.client_id
    where i.id is null
  ) then
    raise exception 'Workflow attribution has a lead without a same-client durable identity.'
      using errcode='23503';
  end if;
end $preflight$;
alter table public.campaign_lead_enrolment_items_v6 drop constraint campaign_lead_enrolment_items_v6_lead_id_fkey;
alter table public.campaign_lead_enrolment_items_v6 add constraint campaign_lead_enrolment_items_v6_lead_id_identity_fkey_v11
  foreign key (lead_id,client_id) references public.lead_identities(id,client_id)
  on delete CASCADE;
alter table public.campaign_page_publications drop constraint campaign_page_publications_probe_lead_id_fkey;
alter table public.campaign_page_publications add constraint campaign_page_publications_probe_lead_id_identity_fkey_v11
  foreign key (probe_lead_id,client_id) references public.lead_identities(id,client_id)
  on delete SET NULL (probe_lead_id);
alter table public.client_appointments drop constraint client_appointments_lead_id_fkey;
alter table public.client_appointments add constraint client_appointments_lead_id_identity_fkey_v11
  foreign key (lead_id,client_id) references public.lead_identities(id,client_id)
  on delete CASCADE;
alter table public.dm_conversations drop constraint dm_conversations_lead_id_fkey;
alter table public.dm_conversations add constraint dm_conversations_lead_id_identity_fkey_v11
  foreign key (lead_id,client_id) references public.lead_identities(id,client_id)
  on delete SET NULL (lead_id);
alter table public.dm_identities drop constraint dm_identities_lead_id_fkey;
alter table public.dm_identities add constraint dm_identities_lead_id_identity_fkey_v11
  foreign key (lead_id,client_id) references public.lead_identities(id,client_id)
  on delete SET NULL (lead_id);
alter table public.lead_magnet_deliveries drop constraint lead_magnet_deliveries_lead_id_fkey;
alter table public.lead_magnet_deliveries add constraint lead_magnet_deliveries_lead_id_identity_fkey_v11
  foreign key (lead_id,client_id) references public.lead_identities(id,client_id)
  on delete SET NULL (lead_id);
alter table public.lead_sequence_enrollments drop constraint lead_sequence_enrollments_lead_id_fkey;
alter table public.lead_sequence_enrollments add constraint lead_sequence_enrollments_lead_id_identity_fkey_v11
  foreign key (lead_id,client_id) references public.lead_identities(id,client_id)
  on delete CASCADE;
alter table public.outbound_messages drop constraint outbound_messages_lead_id_fkey;
alter table public.outbound_messages add constraint outbound_messages_lead_id_identity_fkey_v11
  foreign key (lead_id,client_id) references public.lead_identities(id,client_id)
  on delete CASCADE;
alter table public.proof_outcome_followup_consents_v7 drop constraint proof_outcome_followup_consents_v7_lead_id_fkey;
alter table public.proof_outcome_followup_consents_v7 add constraint proof_outcome_followup_consents_v7_lead_id_identity_fkey_v11
  foreign key (lead_id,client_id) references public.lead_identities(id,client_id)
  on delete RESTRICT;
alter table public.proof_request_deliveries drop constraint proof_request_deliveries_outcome_lead_id_fkey;
alter table public.proof_request_deliveries add constraint proof_request_deliveries_outcome_lead_id_identity_fkey_v11
  foreign key (outcome_lead_id,client_id) references public.lead_identities(id,client_id)
  on delete RESTRICT;
alter table public.proof_service_outcomes_v7 drop constraint proof_service_outcomes_v7_lead_id_fkey;
alter table public.proof_service_outcomes_v7 add constraint proof_service_outcomes_v7_lead_id_identity_fkey_v11
  foreign key (lead_id,client_id) references public.lead_identities(id,client_id)
  on delete RESTRICT;
alter table public.workflow_lead_attribution
  drop constraint workflow_lead_attribution_lead_id_fkey;
alter table public.workflow_lead_attribution
  add constraint workflow_lead_attribution_lead_identity_fkey_v11
  foreign key (lead_id) references public.lead_identities(id) on delete cascade;

-- The foreign key preserves history; this trigger preserves the operating
-- boundary even for direct service writes that bypass the usual RPC.
create function public.guard_active_lead_reference_v11()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare v_row jsonb:=to_jsonb(new); v_lead uuid; v_client uuid;
begin
  v_lead:=nullif(v_row->>tg_argv[0],'')::uuid;
  if v_lead is null then return new; end if;
  if tg_argv[1]='workflow_run' then
    select r.client_id into v_client from public.workflow_runs r
    where r.id=nullif(v_row->>'run_id','')::uuid;
  else
    v_client:=nullif(v_row->>'client_id','')::uuid;
  end if;
  -- Serialize a new dependent write with archive_lead's FOR UPDATE lock:
  -- either the write commits first and archive sees it, or archive removes the
  -- active row first and this guard refuses the new work.
  if v_client is null or not exists (
    select 1 from public.client_leads l
    where l.id=v_lead and l.client_id=v_client
    for key share
  ) then
    raise exception 'An operational lead reference requires a current same-client lead.'
      using errcode='23503';
  end if;
  return new;
end $$;
revoke all on function public.guard_active_lead_reference_v11()
  from public,anon,authenticated,service_role;
create trigger campaign_lead_enrolment_items_v6_lead_id_active_guard_v11
  before insert or update of lead_id,client_id on public.campaign_lead_enrolment_items_v6
  for each row execute function public.guard_active_lead_reference_v11('lead_id','client_id');
create trigger campaign_page_publications_probe_lead_id_active_guard_v11
  before insert or update of probe_lead_id,client_id on public.campaign_page_publications
  for each row execute function public.guard_active_lead_reference_v11('probe_lead_id','client_id');
create trigger client_appointments_lead_id_active_guard_v11
  before insert or update of lead_id,client_id on public.client_appointments
  for each row execute function public.guard_active_lead_reference_v11('lead_id','client_id');
create trigger dm_conversations_lead_id_active_guard_v11
  before insert or update of lead_id,client_id on public.dm_conversations
  for each row execute function public.guard_active_lead_reference_v11('lead_id','client_id');
create trigger dm_identities_lead_id_active_guard_v11
  before insert or update of lead_id,client_id on public.dm_identities
  for each row execute function public.guard_active_lead_reference_v11('lead_id','client_id');
create trigger lead_magnet_deliveries_lead_id_active_guard_v11
  before insert or update of lead_id,client_id on public.lead_magnet_deliveries
  for each row execute function public.guard_active_lead_reference_v11('lead_id','client_id');
create trigger lead_sequence_enrollments_lead_id_active_guard_v11
  before insert or update of lead_id,client_id on public.lead_sequence_enrollments
  for each row execute function public.guard_active_lead_reference_v11('lead_id','client_id');
create trigger outbound_messages_lead_id_active_guard_v11
  before insert or update of lead_id,client_id on public.outbound_messages
  for each row execute function public.guard_active_lead_reference_v11('lead_id','client_id');
create trigger proof_outcome_followup_consents_v7_lead_id_active_guard_v11
  before insert or update of lead_id,client_id on public.proof_outcome_followup_consents_v7
  for each row execute function public.guard_active_lead_reference_v11('lead_id','client_id');
create trigger proof_request_deliveries_outcome_lead_id_active_guard_v11
  before insert or update of outcome_lead_id,client_id on public.proof_request_deliveries
  for each row execute function public.guard_active_lead_reference_v11('outcome_lead_id','client_id');
create trigger proof_service_outcomes_v7_lead_id_active_guard_v11
  before insert or update of lead_id,client_id on public.proof_service_outcomes_v7
  for each row execute function public.guard_active_lead_reference_v11('lead_id','client_id');
create trigger workflow_lead_attribution_active_guard_v11
  before insert or update of lead_id,run_id on public.workflow_lead_attribution
  for each row execute function public.guard_active_lead_reference_v11('lead_id','workflow_run');

-- Keep the cash guard and make unfinished obligations an explicit archive
-- blocker. Finished rows remain linked to the durable identity after delete.
CREATE OR REPLACE FUNCTION public.archive_lead(p_lead_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_lead client_leads%rowtype;
begin
  select * into v_lead from client_leads where id = p_lead_id for update;
  if not found then raise exception 'That lead no longer exists.'; end if;
  if not may_manage_client_leads(v_lead.client_id) then raise exception 'Not permitted for this client'; end if;
  if coalesce(v_lead.cash_collected,0) > 0 then
    raise exception 'This lead has cash collected. Archiving it would remove that revenue from reports.';
  end if;
  if exists (select 1 from public.outbound_messages m
       where m.lead_id=p_lead_id and m.status not in ('sent','cancelled'))
     or exists (select 1 from public.lead_sequence_enrollments e
       where e.lead_id=p_lead_id and e.status='active')
     or exists (select 1 from public.client_appointments a
       where a.lead_id=p_lead_id and a.status='booked')
     or exists (select 1 from public.lead_magnet_deliveries d
       where d.lead_id=p_lead_id and d.status not in ('sent','cancelled'))
     or exists (select 1 from public.proof_request_deliveries d
       where d.outcome_lead_id=p_lead_id and d.status not in ('sent','cancelled'))
     or exists (select 1 from public.dm_conversations c
       where c.lead_id=p_lead_id and c.status='open') then
    raise exception 'Resolve pending lead obligations before archiving.'
      using errcode='23514';
  end if;
  if v_lead.stage in ('lead','sale') then
    raise exception 'Move this legacy lead to a current stage before archiving.';
  end if;
  insert into archived_leads (id,client_id,name,stage_at_archive,lead,events,reason,archived_by)
  select v_lead.id,v_lead.client_id,v_lead.name,v_lead.stage,to_jsonb(v_lead),
    coalesce((select jsonb_agg(to_jsonb(e) order by e.occurred_at,e.id)
      from lead_events e where e.lead_id = p_lead_id),'[]'::jsonb),
    nullif(trim(coalesce(p_reason,'')),''),auth.uid();
  delete from client_leads where id = p_lead_id;
end;
$function$;
revoke all on function public.archive_lead(uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.archive_lead(uuid,text)
  to authenticated,service_role;
select public.lock_down_definer_functions();
commit;

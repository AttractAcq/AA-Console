-- Withdrawal stops future campaign proof effects. Preserve a concrete
-- removal demand for placements already released by that decision.
begin;

create table public.campaign_proof_retraction_demands_v6 (
  approval_id uuid not null references public.campaign_action_approvals(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  placement_id uuid not null references public.proof_placements(id) on delete restrict,
  requested_at timestamptz not null default now(),
  reason text not null,
  primary key (approval_id,placement_id)
);
create index campaign_proof_retraction_demands_client_idx
  on public.campaign_proof_retraction_demands_v6(client_id,requested_at desc);
create trigger campaign_proof_retraction_demands_append_only_v6
  before update or delete on public.campaign_proof_retraction_demands_v6
  for each row execute function public.reject_approval_ledger_mutation_v6();
create trigger campaign_proof_retraction_demands_no_truncate_v6
  before truncate on public.campaign_proof_retraction_demands_v6
  for each statement execute function public.reject_approval_ledger_mutation_v6();
alter table public.campaign_proof_retraction_demands_v6 enable row level security;
create policy campaign_proof_retraction_demands_read_v6
  on public.campaign_proof_retraction_demands_v6 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.campaign_proof_retraction_demands_v6
  from public,anon,authenticated,service_role;
grant select on public.campaign_proof_retraction_demands_v6
  to authenticated,service_role;

create function public.flag_revoked_campaign_proof_placements_v6()
returns trigger language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
begin
  insert into public.campaign_proof_retraction_demands_v6
    (approval_id,client_id,placement_id,reason)
  select new.approval_id,new.client_id,p.id,new.reason
  from public.proof_placement_approvals a
  join public.proof_placements p on p.id=a.placement_id and p.client_id=a.client_id
  where a.campaign_action_approval_id=new.approval_id
    and a.client_id=new.client_id
    and p.status not in ('rejected','retracted');

  -- A queued placement is prevented from publishing by the existing
  -- current-decision prewrite gate. Move it into the removal queue as well.
  -- A placement already 'placing' may have reached its provider; leave that
  -- state intact so the worker can record an outcome before a person removes
  -- it. Its demand row remains visible throughout.
  with flagged as (
    update public.proof_placements p set status='retraction_required'
    from public.campaign_proof_retraction_demands_v6 d
    where d.approval_id=new.approval_id and d.client_id=new.client_id
      and d.placement_id=p.id and p.client_id=new.client_id
      and p.status in ('drafted','awaiting_approval','approved','queued',
        'awaiting_manual_placement','bound','placed','verified')
    returning p.id,p.client_id)
  insert into public.proof_placement_events
    (placement_id,client_id,event,actor,detail)
  select f.id,f.client_id,'retraction_required','system',
    'The campaign proof action was withdrawn: '||new.reason
  from flagged f;
  return new;
end $$;
create trigger campaign_proof_action_revocation_retraction_v6
  after insert on public.campaign_action_revocations_v6
  for each row execute function public.flag_revoked_campaign_proof_placements_v6();
revoke all on function public.flag_revoked_campaign_proof_placements_v6()
  from public,anon,authenticated,service_role;

-- If a provider write was already in flight when the withdrawal arrived,
-- let its normal path record the provider result first. At transaction end,
-- move a newly placed result into the removal queue. Deferring this trigger
-- keeps its event after the provider-result event in the append-only ledger.
create function public.flag_completed_revoked_proof_placement_v6()
returns trigger language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare v_id uuid;
begin
  if not exists (select 1 from public.campaign_proof_retraction_demands_v6 d
      where d.placement_id=new.id and d.client_id=new.client_id) then
    return new;
  end if;
  update public.proof_placements p set status='retraction_required'
    where p.id=new.id and p.client_id=new.client_id
      and p.status in ('placed','verified') returning p.id into v_id;
  if v_id is not null then
    insert into public.proof_placement_events
      (placement_id,client_id,event,actor,detail)
    values (new.id,new.client_id,'retraction_required','system',
      'A withdrawn campaign proof placement completed after the withdrawal.');
  end if;
  return new;
end $$;
create constraint trigger campaign_proof_late_placement_retraction_v6
  after update of status on public.proof_placements
  deferrable initially deferred for each row
  when (new.status in ('placed','verified'))
  execute function public.flag_completed_revoked_proof_placement_v6();
revoke all on function public.flag_completed_revoked_proof_placement_v6()
  from public,anon,authenticated,service_role;

create view public.campaign_proof_retraction_status_v6
with (security_barrier=true) as
select d.approval_id,d.client_id,d.placement_id,d.requested_at,d.reason,
  p.destination_key,p.status as placement_status,p.external_id,p.external_url,
  p.retracted_at,
  case when p.status='retracted' then 'recorded_removed'
    when p.status='placing' then 'in_flight_inspect_provider'
    when p.status='failed' then 'failed_inspect_provider'
    else 'removal_pending' end as demand_status
from public.campaign_proof_retraction_demands_v6 d
join public.proof_placements p on p.id=d.placement_id and p.client_id=d.client_id
where public.can_access_client(d.client_id);
revoke all on public.campaign_proof_retraction_status_v6
  from public,anon,authenticated,service_role;
grant select on public.campaign_proof_retraction_status_v6
  to authenticated,service_role;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
select c.class_id,c.revision+1,c.class_key,c.title,
 'verified','274 exact action Inbox source; 325 atomic handler-owned claim',
 'verified','274 AAL2 decision; 331 revocation',
 'blocked','328 attempt receipt; 490 uncertainty; 495 proof source; 496 lead source; 497 proof retraction demand',
 'Owned runtime release, provider preflight, observed external receipt and actual proof removal are outstanding.'
from public.approval_class_coverage_v6 c where c.class_id=6;

select public.lock_down_definer_functions();
commit;

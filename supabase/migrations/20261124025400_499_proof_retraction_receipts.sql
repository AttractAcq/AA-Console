-- A status-only 'retracted' row cannot prove that a live placement came down.
-- Keep an append-only confirmation before changing the placement state.
begin;

create table public.proof_placement_retraction_receipts_v6 (
  id uuid primary key default gen_random_uuid(),
  placement_id uuid not null unique references public.proof_placements(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  method text not null check (method in
    ('cancelled_before_placement','human_checked','provider_readback')),
  evidence_ref text,
  reason text not null check (length(btrim(reason)) between 3 and 1000),
  recorded_by uuid references public.profiles(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  check ((method='cancelled_before_placement' and evidence_ref is null)
    or (method in ('human_checked','provider_readback')
      and length(btrim(evidence_ref)) between 8 and 2000))
);
create index proof_placement_retraction_receipts_client_idx
  on public.proof_placement_retraction_receipts_v6(client_id,recorded_at desc);
create trigger proof_placement_retraction_receipts_append_only_v6
  before update or delete on public.proof_placement_retraction_receipts_v6
  for each row execute function public.reject_approval_ledger_mutation_v6();
create trigger proof_placement_retraction_receipts_no_truncate_v6
  before truncate on public.proof_placement_retraction_receipts_v6
  for each statement execute function public.reject_approval_ledger_mutation_v6();
alter table public.proof_placement_retraction_receipts_v6 enable row level security;
create policy proof_placement_retraction_receipts_read_v6
  on public.proof_placement_retraction_receipts_v6 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.proof_placement_retraction_receipts_v6
  from public,anon,authenticated,service_role;
grant select on public.proof_placement_retraction_receipts_v6 to authenticated,service_role;

create function public.guard_proof_retraction_receipt_v6()
returns trigger language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
begin
  if new.status='retracted' and old.status is distinct from 'retracted'
    and not exists(select 1 from public.proof_placement_retraction_receipts_v6 r
      where r.placement_id=new.id and r.client_id=new.client_id) then
    raise exception 'Record removal confirmation before marking proof retracted.'
      using errcode='23514';
  end if;
  return new;
end $$;
create trigger proof_retraction_receipt_guard_v6
  before update of status on public.proof_placements
  for each row execute function public.guard_proof_retraction_receipt_v6();
revoke all on function public.guard_proof_retraction_receipt_v6()
  from public,anon,authenticated,service_role;

create function public.record_proof_retraction_confirmation_v6(
  p_placement_id uuid,p_method text,p_evidence_ref text,p_reason text)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare p public.proof_placements%rowtype; v_id uuid;
  v_evidence text := nullif(btrim(coalesce(p_evidence_ref,'')),'');
  v_reason text := nullif(btrim(coalesce(p_reason,'')),'');
begin
  if auth.role() not in ('authenticated','service_role') then
    raise exception 'A trusted actor must confirm proof removal.' using errcode='42501';
  end if;
  select * into p from public.proof_placements where id=p_placement_id for update;
  if not found then raise exception 'No such placement.' using errcode='23514'; end if;
  if p.status not in ('placed','verified','retraction_required') then
    raise exception 'This placement is not awaiting removal confirmation.'
      using errcode='23514';
  end if;
  if auth.role()='authenticated' then
    if auth.uid() is null or public.current_role_of() is null
      or coalesce(auth.jwt()->>'aal','')<>'aal2'
      or not (coalesce(public.is_admin(),false)
        or coalesce(auth.uid()=public.active_video_approval_manager(p.client_id),false))
    then raise exception 'A provisioned AAL2 owner must confirm proof removal.'
      using errcode='42501'; end if;
    if p_method='provider_readback' then
      raise exception 'A human cannot claim a provider readback.' using errcode='42501';
    end if;
  end if;
  if p_method not in ('cancelled_before_placement','human_checked','provider_readback')
    or v_reason is null or length(v_reason) not between 3 and 1000 then
    raise exception 'A valid removal method and reason are required.' using errcode='22023';
  end if;
  if p_method='cancelled_before_placement' then
    if p.status<>'retraction_required' or p.placed_at is not null
      or p.external_id is not null or p.external_url is not null
      or v_evidence is not null then
      raise exception 'A placement that may have gone live needs removal evidence.'
        using errcode='23514'; end if;
  elsif v_evidence is null or length(v_evidence) not between 8 and 2000
    or (p.placed_at is null and p.external_id is null and p.external_url is null) then
    raise exception 'A live placement needs a bounded removal evidence reference.'
      using errcode='23514';
  end if;

  insert into public.proof_placement_retraction_receipts_v6
    (placement_id,client_id,method,evidence_ref,reason,recorded_by)
  values (p.id,p.client_id,p_method,v_evidence,v_reason,
    case when auth.role()='authenticated' then auth.uid() else null end)
  returning id into v_id;
  update public.proof_placements set status='retracted',retracted_at=now()
    where id=p.id;
  insert into public.proof_placement_events
    (placement_id,client_id,event,actor,detail,external_ref)
  values (p.id,p.client_id,'retracted',
    case when auth.role()='service_role' then 'agent' else 'human' end,
    p_method||': '||v_reason,v_evidence);
  return v_id;
end $$;

-- The old status-only RPC remains defined for historical migrations, but
-- no application role may invoke it after this migration.
revoke all on function public.record_proof_retracted_v6(uuid,text)
  from public,anon,authenticated,service_role;
revoke all on function public.record_proof_retraction_confirmation_v6(uuid,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.record_proof_retraction_confirmation_v6(uuid,text,text,text)
  to authenticated,service_role;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
select c.class_id,c.revision+1,c.class_key,c.title,
 'verified','352 exact placement Inbox source; 497 campaign withdrawal demand',
 'verified','352 AAL2 decision; 498 AAL2 manual removal confirmation',
 'blocked','355 prewrite gate; 498 append-only removal receipt and status guard',
 'Provider removal/readback and historical status-only retraction audit are outstanding.'
from public.approval_class_coverage_v6 c where c.class_id=8;

select public.lock_down_definer_functions();
commit;

-- Older placements may say 'retracted' without any removal receipt.
-- Preserve that historical status and record a separate, later attestation.
begin;

alter table public.proof_placement_retraction_receipts_v6
  add column legacy_audit boolean not null default false,
  add constraint proof_retraction_legacy_audit_method_v6
    check (not legacy_audit or method='human_checked');

create function public.audit_legacy_proof_retraction_v6(
  p_placement_id uuid,p_evidence_ref text,p_reason text)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare p public.proof_placements%rowtype; v_id uuid;
  v_evidence text := nullif(btrim(coalesce(p_evidence_ref,'')),'');
  v_reason text := nullif(btrim(coalesce(p_reason,'')),'');
begin
  if auth.role()<>'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or coalesce(auth.jwt()->>'aal','')<>'aal2' then
    raise exception 'A provisioned AAL2 owner must audit historical proof removal.'
      using errcode='42501';
  end if;
  select * into p from public.proof_placements where id=p_placement_id for update;
  if not found then raise exception 'No such placement.' using errcode='23514'; end if;
  if not (coalesce(public.is_admin(),false)
      or coalesce(auth.uid()=public.active_video_approval_manager(p.client_id),false)) then
    raise exception 'This owner cannot audit the placement.' using errcode='42501';
  end if;
  if p.status<>'retracted' or exists(
    select 1 from public.proof_placement_retraction_receipts_v6 r
      where r.placement_id=p.id) then
    raise exception 'Only a legacy retraction without a receipt can be audited.'
      using errcode='23514';
  end if;
  if v_reason is null or length(v_reason) not between 3 and 1000
    or v_evidence is null or length(v_evidence) not between 8 and 2000 then
    raise exception 'A reason and removal evidence reference are required.'
      using errcode='22023';
  end if;
  insert into public.proof_placement_retraction_receipts_v6
    (placement_id,client_id,method,evidence_ref,reason,recorded_by,legacy_audit)
  values (p.id,p.client_id,'human_checked',v_evidence,v_reason,auth.uid(),true)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.audit_legacy_proof_retraction_v6(uuid,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.audit_legacy_proof_retraction_v6(uuid,text,text)
  to authenticated;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
select c.class_id,c.revision+1,c.class_key,c.title,
 'verified','352 exact placement Inbox source; 497 withdrawal demand; 499 legacy inventory',
 'verified','352 AAL2 decision; 498 removal confirmation; 499 legacy AAL2 audit',
 'blocked','498 append-only removal receipt; 499 historical audit path',
 'Provider removal and readback remain unverified for supported destinations.'
from public.approval_class_coverage_v6 c where c.class_id=8;

select public.lock_down_definer_functions();
commit;

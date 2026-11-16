-- Bind a budget action to the source row and live campaign budget context.
-- A field edit advances an epoch, so changing and restoring words or amounts
-- cannot revive the old Inbox card.
begin;

alter table public.campaign_budget_changes
 add column review_epoch_v6 bigint not null default 0;
alter table public.client_campaigns
 add column budget_context_epoch_v6 bigint not null default 0;

create function public.advance_campaign_budget_review_epoch_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if tg_table_name='campaign_budget_changes' then
  if (new.client_id,new.campaign_id,new.ad_set_external_id,
      new.current_daily_budget,new.proposed_daily_budget,new.currency,new.reason)
   is distinct from
     (old.client_id,old.campaign_id,old.ad_set_external_id,
      old.current_daily_budget,old.proposed_daily_budget,old.currency,old.reason) then
   new.review_epoch_v6:=old.review_epoch_v6+1;
  elsif new.review_epoch_v6 is distinct from old.review_epoch_v6 then
   raise exception 'Budget review epoch is system-owned.' using errcode='42501';
  end if;
 else
  if (new.meta_ad_set_id,new.daily_budget) is distinct from
     (old.meta_ad_set_id,old.daily_budget) then
   new.budget_context_epoch_v6:=old.budget_context_epoch_v6+1;
  elsif new.budget_context_epoch_v6 is distinct from old.budget_context_epoch_v6 then
   raise exception 'Campaign budget context epoch is system-owned.' using errcode='42501';
  end if;
 end if;
 return new;
end $$;
create trigger budget_change_review_epoch_v6 before update on public.campaign_budget_changes
 for each row execute function public.advance_campaign_budget_review_epoch_v6();
create trigger campaign_budget_context_epoch_v6 before update on public.client_campaigns
 for each row execute function public.advance_campaign_budget_review_epoch_v6();
revoke all on function public.advance_campaign_budget_review_epoch_v6()
 from public,anon,authenticated,service_role;

create function public.campaign_budget_exact_snapshot_v6(p_change_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object(
  'change_id',c.id,'client_id',c.client_id,'campaign_id',c.campaign_id,
  'ad_set_external_id',c.ad_set_external_id,
  'current_daily_budget',c.current_daily_budget,
  'proposed_daily_budget',c.proposed_daily_budget,
  'currency',c.currency,'reason',c.reason,'review_epoch',c.review_epoch_v6,
  'campaign_ad_set_id',campaign.meta_ad_set_id,
  'campaign_daily_budget',campaign.daily_budget,
  'campaign_budget_context_epoch',campaign.budget_context_epoch_v6)
 from public.campaign_budget_changes c
 join public.client_campaigns campaign on campaign.id=c.campaign_id
  and campaign.client_id=c.client_id
 where c.id=p_change_id;
$$;
revoke all on function public.campaign_budget_exact_snapshot_v6(uuid)
 from public,anon,authenticated,service_role;

create function public.attach_campaign_budget_inbox_evidence_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.campaign_action_approvals%rowtype;
 r public.approval_requests_v6%rowtype; snapshot jsonb;
 expected_hash text;
begin
 if new.approval_id is null or new.approval_id is not distinct from old.approval_id
  then return new; end if;
 select * into a from public.campaign_action_approvals where id=new.approval_id;
 select * into r from public.approval_requests_v6 where source_system='aa_console'
  and source_kind='campaign_action' and source_id=a.id::text
  and source_version=a.request_hash;
 snapshot:=public.campaign_budget_exact_snapshot_v6(new.id);
 expected_hash:=encode(sha256(convert_to(
  new.ad_set_external_id||':'||new.proposed_daily_budget::text,'UTF8')),'hex');
 if a.id is null or r.id is null or a.action_key<>'budget_change'
  or a.client_id is distinct from new.client_id
  or a.campaign_id is distinct from new.campaign_id
  or a.scope->>'budget_change_id' is distinct from new.id::text
  or a.scope->>'ad_set_external_id' is distinct from new.ad_set_external_id
  or a.scope->'current_daily_budget' is distinct from to_jsonb(new.current_daily_budget)
  or a.scope->'proposed_daily_budget' is distinct from to_jsonb(new.proposed_daily_budget)
  or a.scope->>'currency' is distinct from new.currency
  or a.scope->>'reason' is distinct from new.reason
  or a.artifact_version_hash is distinct from expected_hash
  or snapshot->>'campaign_ad_set_id' is distinct from new.ad_set_external_id
  or snapshot->'campaign_daily_budget' is distinct from to_jsonb(new.current_daily_budget)
  then raise exception 'Budget action does not attest its source row and current campaign budget.'
    using errcode='23514'; end if;
 perform public.attach_approval_evidence_v6(r.id,r.source_version,
  'campaign_budget_changes:'||new.id::text,
  jsonb_build_object('artifact_hash',expected_hash,
   'preview',r.preview||jsonb_build_object('budget_change',snapshot),
   'destination',a.destination,'account_ref',r.account_ref,
   'budget',r.budget,'scope',a.scope));
 return new;
end $$;
create trigger campaign_budget_exact_inbox_evidence_v6
 after update of approval_id on public.campaign_budget_changes
 for each row execute function public.attach_campaign_budget_inbox_evidence_v6();
revoke all on function public.attach_campaign_budget_inbox_evidence_v6()
 from public,anon,authenticated,service_role;

create function public.campaign_action_exact_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare state text; r public.approval_requests_v6%rowtype;
 a public.campaign_action_approvals%rowtype;
 c public.campaign_budget_changes%rowtype;
 e public.approval_request_evidence_v6%rowtype;
 snapshot jsonb; expected_hash text;
begin
 state:=public.approval_source_state_v6(p_request_id);
 if state not in ('pending','source_decided') then return state; end if;
 select * into r from public.approval_requests_v6 where id=p_request_id;
 if r.source_system<>'aa_console' or r.source_kind<>'campaign_action' then return state; end if;
 select * into a from public.campaign_action_approvals
  where id=r.source_id::uuid and client_id=r.client_id;
 if a.id is null or a.action_key<>'budget_change' then return state; end if;
 select * into c from public.campaign_budget_changes
  where id=nullif(a.scope->>'budget_change_id','')::uuid;
 select * into e from public.approval_request_evidence_v6 where request_id=r.id;
 snapshot:=public.campaign_budget_exact_snapshot_v6(c.id);
 expected_hash:=encode(sha256(convert_to(
  c.ad_set_external_id||':'||c.proposed_daily_budget::text,'UTF8')),'hex');
 if c.id is null or e.id is null or snapshot is null
  or c.approval_id is distinct from a.id or c.client_id is distinct from a.client_id
  or c.campaign_id is distinct from a.campaign_id
  or (case when c.status='applied' then
    ((e.preview->'budget_change') - array['campaign_ad_set_id',
      'campaign_daily_budget','campaign_budget_context_epoch']::text[])
      is distinct from
    (snapshot - array['campaign_ad_set_id',
      'campaign_daily_budget','campaign_budget_context_epoch']::text[])
    else e.preview->'budget_change' is distinct from snapshot end)
  or a.scope->>'ad_set_external_id' is distinct from c.ad_set_external_id
  or a.scope->'current_daily_budget' is distinct from to_jsonb(c.current_daily_budget)
  or a.scope->'proposed_daily_budget' is distinct from to_jsonb(c.proposed_daily_budget)
  or a.scope->>'currency' is distinct from c.currency
  or a.scope->>'reason' is distinct from c.reason
  or a.artifact_version_hash is distinct from expected_hash
  or (c.status<>'applied' and (
    snapshot->>'campaign_ad_set_id' is distinct from c.ad_set_external_id
    or snapshot->'campaign_daily_budget' is distinct from to_jsonb(c.current_daily_budget)))
  then return 'superseded'; end if;
 return state;
end $$;
revoke all on function public.campaign_action_exact_source_state_v6(uuid)
 from public,anon,authenticated,service_role;

select public.lock_down_definer_functions();
commit;

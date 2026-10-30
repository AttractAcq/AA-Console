-- B008 / 279: a fail-red, machine-readable inventory of every known human
-- approval class. This records reviewed implementation evidence, not runtime
-- authority. A source card alone never makes a class operational: its owning
-- AAL2 decision and last-moment external executor attestation are separate.
-- Revisions are append-only and can be advanced only by a later migration.

create table public.approval_class_coverage_versions_v6 (
  class_id smallint not null check (class_id > 0),
  revision integer not null check (revision > 0),
  class_key text not null check (class_key ~ '^[a-z][a-z0-9_]+$'),
  title text not null check (length(btrim(title)) between 1 and 200),
  source_state text not null check (source_state in ('missing','blocked','verified')),
  source_evidence text,
  decision_state text not null check (decision_state in ('missing','blocked','verified')),
  decision_evidence text,
  executor_state text not null check (executor_state in ('missing','blocked','verified')),
  executor_evidence text,
  blocker text,
  recorded_at timestamptz not null default now(),
  primary key (class_id, revision),
  unique (class_key, revision),
  check (source_state <> 'verified' or nullif(btrim(source_evidence), '') is not null),
  check (decision_state <> 'verified' or nullif(btrim(decision_evidence), '') is not null),
  check (executor_state <> 'verified' or nullif(btrim(executor_evidence), '') is not null)
);
create function public.guard_approval_class_coverage_version_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_latest public.approval_class_coverage_versions_v6%rowtype;
begin
  if exists (select 1 from public.approval_class_coverage_versions_v6
      where class_key = new.class_key and class_id <> new.class_id) then
    raise exception 'An approval class key belongs to another class ID.'
      using errcode = '23505';
  end if;
  select * into v_latest from public.approval_class_coverage_versions_v6
    where class_id = new.class_id order by revision desc limit 1 for update;
  if found then
    if new.revision <> v_latest.revision + 1
      or new.class_key <> v_latest.class_key
      or new.title <> v_latest.title then
      raise exception 'Coverage revision must follow the same immutable class identity.'
        using errcode = '23514';
    end if;
  elsif new.revision <> 1 then
    raise exception 'A new approval class starts at coverage revision 1.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_approval_class_coverage_version_v6()
  from public, anon, authenticated, service_role;
create trigger approval_class_coverage_version_guard_v6
  before insert on public.approval_class_coverage_versions_v6
  for each row execute function public.guard_approval_class_coverage_version_v6();
create trigger approval_class_coverage_append_only_v6
  before update or delete on public.approval_class_coverage_versions_v6
  for each row execute function public.reject_approval_ledger_mutation_v6();
create trigger approval_class_coverage_no_truncate_v6
  before truncate on public.approval_class_coverage_versions_v6
  for each statement execute function public.reject_approval_ledger_mutation_v6();
alter table public.approval_class_coverage_versions_v6 enable row level security;
create policy approval_class_coverage_admin_read_v6
  on public.approval_class_coverage_versions_v6 for select to authenticated
  using (coalesce(public.is_admin(), false));
revoke all on public.approval_class_coverage_versions_v6
  from public, anon, authenticated, service_role;
grant select on public.approval_class_coverage_versions_v6 to authenticated, service_role;

insert into public.approval_class_coverage_versions_v6
  (class_id,revision,class_key,title,source_state,source_evidence,
   decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values
  (1,1,'engine_slot','Engine slot release','blocked','277 slot_events_inbox_register_v6',
   'missing',null,'missing',null,'Media byte digest, exact publisher account, owning AAL2 transition and publish recheck are missing.'),
  (2,1,'ordinary_media','Ordinary media acceptance','missing',null,
   'missing',null,'missing',null,'No durable request epoch or trusted media-byte snapshot.'),
  (3,1,'video_owner','Video owner signoff','missing',null,
   'missing',null,'missing',null,'Owner seat and render bytes are not bound to an Inbox request.'),
  (4,1,'video_manager','Video SMM signoff','missing',null,
   'missing',null,'missing',null,'Manager seat and render bytes are not bound to an Inbox request.'),
  (5,1,'video_client','Video client signoff','missing',null,
   'missing',null,'missing',null,'Client re-request epoch and render bytes are not bound to an Inbox request.'),
  (6,1,'campaign_action','Campaign external action','blocked','274 campaign_action_inbox_register_v6',
   'verified','274 campaign_action_inbox_decision_v6','missing',null,
   'Only Google Ads JSON and page HTML previews are proved; other action keys and executor rechecks remain incomplete.'),
  (7,1,'lead_magnet','Lead magnet approval','missing',null,
   'missing',null,'missing',null,'File bytes and delivery words need source-owned exact evidence.'),
  (8,1,'proof_placement','Proof placement','missing',null,
   'missing',null,'missing',null,'Placement, rights and destination are not bridged.'),
  (9,1,'proof_delivery','Proof capture delivery','missing',null,
   'missing',null,'missing',null,'Recipient and exact message bytes are not bridged.'),
  (10,1,'proof_artifact','Proof artifact signoff','missing',null,
   'missing',null,'missing',null,'Artifact version and rights are not bridged.'),
  (11,1,'proof_rights','Proof usage rights','missing',null,
   'missing',null,'missing',null,'A source-owned rights request/decision RPC is missing.'),
  (12,1,'service_offer','Service offer signoff','missing',null,
   'missing',null,'missing',null,'Offer economics/version are not bridged.'),
  (13,1,'opportunity_approve','Market opportunity approval','missing',null,
   'missing',null,'missing',null,'No frozen pending opportunity snapshot.'),
  (14,1,'opportunity_activate','Market opportunity activation','missing',null,
   'missing',null,'missing',null,'Activation is not a separately versioned decision.'),
  (15,1,'motion_render','Motion render acceptance','missing',null,
   'missing',null,'missing',null,'Render bytes and scene/QA evidence are not bridged.'),
  (16,1,'recruitment_brief','Recruitment brief signoff','verified','276 recruitment_brief_inbox_request_v6',
   'verified','276 recruitment_brief_inbox_decision_v6','missing',null,
   'Generation and later external Meta build lack a last-moment Inbox executor attestation.'),
  (17,1,'recruitment_media','Recruitment media signoff','missing',null,
   'missing',null,'missing',null,'Uses ordinary media path; exact media bytes are not bridged.'),
  (18,1,'recruitment_meta_build','Recruitment Meta object build','missing',null,
   'missing',null,'missing',null,'External paused-object creation lacks its own exact action gate.'),
  (19,1,'message_template','Message template approval','missing',null,
   'missing',null,'missing',null,'Pending request and exact words/consent basis are missing.'),
  (20,1,'nurture_sequence','Nurture sequence approval','missing',null,
   'missing',null,'missing',null,'Ordered step words/version are not bridged.'),
  (21,1,'google_review_reply','Google review reply','verified','278 google_reply_inbox_request_v6',
   'verified','278 google_reply_inbox_decision_v6','missing',null,
   'A reply sender with a last-moment exact Inbox recheck is not live.'),
  (22,1,'google_profile_change','Google profile change','missing',null,
   'missing',null,'missing',null,'No owning profile-change decision RPC or adapter.'),
  (23,1,'meta_profile_change','Meta profile change','missing',null,
   'missing',null,'missing',null,'Source decision exists but is not bridged to exact Inbox scope.'),
  (24,1,'campaign_budget_profile','Campaign budget/profile change','blocked','274 campaign_action_inbox_register_v6',
   'verified','274 campaign_action_inbox_decision_v6','missing',null,
   'Generic action scope does not attest the source budget or field payload.'),
  (25,1,'sales_agent_public_use','Sales agent public-use approval','missing',null,
   'missing',null,'missing',null,'Direct browser status update needs a source-owned request and decision RPC.'),
  (26,1,'campaign_idea','Campaign idea selection','missing',null,
   'missing',null,'missing',null,'Human idea selection and autonomous policy selection need distinct lineage.'),
  (27,1,'page_deploy','Campaign page deployment','verified','274 campaign_page_inbox_evidence_v6',
   'verified','274 campaign_action_inbox_decision_v6','missing',null,
   'Full HTML is frozen, but the deploy executor has not attested the same version.'),
  (28,1,'integration_grant','Integration credential/ingest grant','missing',null,
   'missing',null,'missing',null,'Account/scopes/expiry grant request and audit are missing.'),
  (29,1,'activation_switch','Client/product activation switch','missing',null,
   'missing',null,'missing',null,'Enablement scope and live account verification need separate approvals.'),
  (30,1,'creative_authority','Creative authority assignment','missing',null,
   'missing',null,'missing',null,'Owner/seat assignment is not a canonical governance request.'),
  (31,1,'gateway_tool','Gateway tool approval','missing',null,
   'missing',null,'missing',null,'Gateway SQLite has no authenticated AAL2 bridge or fail-closed attestation.'),
  (32,1,'production_release','Production release approval','missing',null,
   'missing',null,'missing',null,'GitHub/CI/migration/Railway release packet has no canonical in-product bridge.'),
  (33,1,'sales_entitlement','Client sales entitlement grant/revoke','verified','275 sales_entitlement_inbox_request_v6',
   'verified','275 sales_entitlement_inbox_decision_v6','blocked','275 is_eligible_lead_owner',
   'Exact event binding is enforced but inbox_enforced remains off pending activation.'),
  (34,1,'team_invitation','Controlled team invitation','missing',null,
   'missing',null,'missing',null,'B004 invitation source and exact recipient/template/account/expiry approval are not built.');

create view public.approval_class_coverage_v6 with (security_invoker = true) as
with latest as (
  select distinct on (class_id) *
    from public.approval_class_coverage_versions_v6
   order by class_id, revision desc
)
select class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker,
  recorded_at,
  case
    when source_state='verified' and decision_state='verified'
      and executor_state='verified'
      and nullif(btrim(source_evidence),'') is not null
      and nullif(btrim(decision_evidence),'') is not null
      and nullif(btrim(executor_evidence),'') is not null
      then 'operational'
    when source_state='missing' and decision_state='missing'
      then 'missing'
    else 'blocked'
  end as overall_status
from latest;
revoke all on public.approval_class_coverage_v6
  from public, anon, authenticated, service_role;
grant select on public.approval_class_coverage_v6 to authenticated, service_role;

create view public.approval_coverage_summary_v6 with (security_invoker = true) as
select 'b008-34-classes'::text as inventory_version,
  34::integer as expected_classes,
  count(*)::integer as inventoried_classes,
  count(*) filter (where overall_status='operational')::integer as operational_classes,
  count(*) filter (where overall_status='blocked')::integer as blocked_classes,
  count(*) filter (where overall_status='missing')::integer as missing_classes,
  (count(*)=34 and count(*) filter (where overall_status='operational')=34)
    as fully_operational
from public.approval_class_coverage_v6;
revoke all on public.approval_coverage_summary_v6
  from public, anon, authenticated, service_role;
grant select on public.approval_coverage_summary_v6 to authenticated, service_role;

do $$
begin
  if (select count(*) from public.approval_class_coverage_versions_v6
      where revision=1) <> 34 then
    raise exception 'B008 coverage inventory must contain exactly 34 classes.';
  end if;
end;
$$;

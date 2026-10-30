-- B008 / 279: a fail-red, machine-readable inventory of every known human
-- approval class. This records reviewed implementation evidence, not runtime
-- authority. A source card alone never makes a class operational: its owning
-- AAL2 decision and last-moment external executor attestation are separate.
-- Revisions are append-only and can be advanced only by a later migration.

-- A frozen card is still only pending while its owning source remains on the
-- same exact version. The source is checked live under a scoped definer: a
-- later source edit, archive, cancellation, or new Engine epoch cannot leave
-- a misleading actionable card in the canonical view. Unknown source kinds
-- fail closed until their own adapter extends this function.
create function public.approval_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public as $$
declare
  v_request public.approval_requests_v6%rowtype;
  v_source_id uuid;
  v_status text;
  v_version text;
  v_hash text;
  v_archived_at timestamptz;
  v_payload jsonb;
  v_slot_stage text;
  v_epoch text;
  v_epoch_count integer;
begin
  select * into v_request from public.approval_requests_v6 where id = p_request_id;
  if not found then return 'unverified'; end if;
  if auth.role() is distinct from 'service_role'
    and (auth.role() is distinct from 'authenticated'
      or not public.can_review_approval_request_v6(
        v_request.client_id, v_request.owner_role)) then
    return 'unverified';
  end if;
  if v_request.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  v_source_id := v_request.source_id::uuid;

  if v_request.source_system = 'aa_console'
    and v_request.source_kind = 'campaign_action' then
    select a.status, a.request_hash into v_status, v_version
      from public.campaign_action_approvals a where a.id = v_source_id;
    if not found then return 'cancelled'; end if;
    if v_status <> 'pending' then return 'source_decided'; end if;
    if v_version is distinct from v_request.source_version then return 'superseded'; end if;
    return 'pending';
  elsif v_request.source_system = 'aa_console'
    and v_request.source_kind = 'client_sales_entitlement' then
    select s.status, s.scope_hash into v_status, v_version
      from public.client_sales_entitlement_requests s where s.id = v_source_id;
    if not found then return 'cancelled'; end if;
    if v_status <> 'pending' then return 'source_decided'; end if;
    if v_version is distinct from v_request.source_version then return 'superseded'; end if;
    return 'pending';
  elsif v_request.source_system = 'aa_console'
    and v_request.source_kind = 'recruitment_brief' then
    select b.status::text, b.archived_at,
      public.recruitment_brief_snapshot_hash_v6(b)
      into v_status, v_archived_at, v_hash
      from public.client_briefs b where b.id = v_source_id;
    if not found or v_archived_at is not null then return 'cancelled'; end if;
    if v_status <> 'draft' then return 'source_decided'; end if;
    if v_request.artifact_hash is distinct from v_hash
      or v_request.source_version !~ ('^' || v_hash || ':v[1-9][0-9]*$')
      then return 'superseded'; end if;
    return 'pending';
  elsif v_request.source_system = 'aa_console'
    and v_request.source_kind = 'google_review_reply' then
    select g.status, public.google_reply_inbox_payload_v6(g)
      into v_status, v_payload from public.google_review_replies g
      where g.id = v_source_id;
    if not found then return 'cancelled'; end if;
    if v_status not in ('drafted','awaiting_approval') then return 'source_decided'; end if;
    if v_payload->>'source_version' is distinct from v_request.source_version
      or v_payload->>'artifact_hash' is distinct from v_request.artifact_hash
      or v_payload->'preview' is distinct from v_request.preview
      or v_payload->>'destination' is distinct from v_request.destination
      or v_payload->>'account_ref' is distinct from v_request.account_ref
      or v_payload->'scope' is distinct from v_request.scope
      or v_payload->>'preview_blocker' is distinct from v_request.preview_blocker
      then return 'superseded'; end if;
    return 'pending';
  elsif v_request.source_system = 'aa_console'
    and v_request.source_kind = 'engine_slot' then
    select s.stage::text into v_slot_stage from public.content_slots s
      where s.id = v_source_id;
    if not found then return 'cancelled'; end if;
    if v_slot_stage <> 'awaiting_approval' then return 'source_decided'; end if;
    -- Older slot events have transaction-start timestamps and random UUIDs,
    -- neither of which proves order after concurrent serialized transitions.
    -- Multiple approval entries therefore remain unverified and blocked.
    select count(*)::integer, min(e.id::text) into v_epoch_count, v_epoch
      from public.slot_events e
      where e.slot_id = v_source_id and e.to_stage::text = 'awaiting_approval';
    if v_epoch_count <> 1 then return 'unverified'; end if;
    if v_epoch is distinct from v_request.source_version then return 'superseded'; end if;
    return 'pending';
  elsif v_request.source_system = 'auth'
    and v_request.source_kind = 'console_invitation' then
    -- B004 creates this source in 284. Until then there are no valid cards.
    if to_regclass('public.console_invitation_requests_v6') is null
      then return 'unverified'; end if;
    execute 'select status,payload_hash from public.console_invitation_requests_v6 where id=$1'
      into v_status,v_version using v_source_id;
    if not found then return 'cancelled'; end if;
    if v_version is distinct from v_request.source_version then return 'superseded'; end if;
    if v_status = 'requested' then return 'pending'; end if;
    if v_status = 'cancelled' then return 'cancelled'; end if;
    if v_status in ('reconcile','conflict') then return 'source_held'; end if;
    return 'source_decided';
  end if;
  return 'unverified';
end;
$$;
revoke all on function public.approval_source_state_v6(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.approval_source_state_v6(uuid)
  to authenticated, service_role;

create or replace view public.approval_inbox_v6 with (security_invoker = true) as
select
  r.id, r.client_id, r.source_system, r.source_kind, r.source_id,
  r.source_version, r.title,
  case
    when s.source_state in ('cancelled','superseded','source_held','unverified')
      then s.source_state
    when d.decision = 'revoked' then 'revoked'
    when d.decision = 'rejected' then 'rejected'
    when r.expires_at is not null and r.expires_at <= now() then 'expired'
    when d.decision = 'approved' then 'approved'
    when s.source_state <> 'pending' then s.source_state
    else 'pending'
  end as status,
  r.requested_at, r.requested_by, r.requester_kind, r.requester_ref,
  r.expires_at,
  coalesce(e.artifact_hash, r.artifact_hash) as artifact_hash,
  coalesce(e.preview, r.preview) as preview,
  coalesce(e.destination, r.destination) as destination,
  coalesce(e.account_ref, r.account_ref) as account_ref,
  coalesce(e.budget, r.budget) as budget,
  coalesce(e.scope, r.scope) as scope,
  r.owner_role,
  case
    when r.expires_at is null then 'An expiry is missing.'
    when nullif(btrim(coalesce(r.owner_role, '')), '') is null then 'The decision owner is missing.'
    when e.id is not null then null
    when nullif(btrim(coalesce(r.preview_blocker, '')), '') is not null then r.preview_blocker
    when r.artifact_hash is null then 'The exact artifact hash is missing.'
    when r.preview is null or jsonb_typeof(r.preview) <> 'object'
      or r.preview = '{}'::jsonb then 'The exact artifact preview is missing.'
    when r.scope is null or r.scope = '{}'::jsonb then 'The exact scope is missing.'
    else null
  end as preview_blocker,
  r.owning_path,
  s.source_state
from public.approval_requests_v6 r
left join public.approval_request_evidence_v6 e on e.request_id = r.id
left join lateral (
  select de.decision from public.approval_decision_events_v6 de
  where de.request_id = r.id
  order by de.event_order desc limit 1
) d on true
cross join lateral (
  select public.approval_source_state_v6(r.id) as source_state
) s;
revoke all on public.approval_inbox_v6 from public, anon, authenticated, service_role;
grant select on public.approval_inbox_v6 to authenticated, service_role;

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

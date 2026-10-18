-- Human decisions bind one exact campaign package, action, destination and
-- artifact version. This ledger does not execute an external action.
alter table public.campaign_manifest_versions
  add constraint campaign_manifest_versions_identity_uniq
  unique (id, campaign_id, client_id);

create table public.campaign_action_approvals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null,
  campaign_id uuid not null,
  manifest_id uuid not null,
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 160),
  action_key text not null check (action_key in (
    'campaign_launch', 'meta_ad_build', 'google_ad_build', 'organic_publish',
    'proof_publish', 'page_deploy', 'lead_message', 'profile_update', 'budget_change'
  )),
  destination text not null check (length(btrim(destination)) between 1 and 300),
  artifact_version_hash text not null check (artifact_version_hash ~ '^[0-9a-f]{32,128}$'),
  scope jsonb not null check (jsonb_typeof(scope) = 'object'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{32}$'),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.profiles(id) on delete set null,
  rejection_reason text,
  foreign key (manifest_id, campaign_id, client_id)
    references public.campaign_manifest_versions (id, campaign_id, client_id)
    on delete cascade,
  unique (campaign_id, idempotency_key),
  check (
    (status = 'pending' and decided_at is null and decided_by is null and rejection_reason is null)
    or (status = 'approved' and decided_at is not null and decided_by is not null
      and rejection_reason is null)
    or (status = 'rejected' and decided_at is not null and decided_by is not null
      and nullif(btrim(rejection_reason), '') is not null)
  )
);

create index campaign_action_approvals_inbox_idx
  on public.campaign_action_approvals (client_id, requested_at)
  where status = 'pending';

create function public.guard_campaign_action_approval_identity()
returns trigger language plpgsql as $$
begin
  if old.client_id is distinct from new.client_id
    or old.campaign_id is distinct from new.campaign_id
    or old.manifest_id is distinct from new.manifest_id
    or old.idempotency_key is distinct from new.idempotency_key
    or old.action_key is distinct from new.action_key
    or old.destination is distinct from new.destination
    or old.artifact_version_hash is distinct from new.artifact_version_hash
    or old.scope is distinct from new.scope
    or old.request_hash is distinct from new.request_hash
    or old.requested_at is distinct from new.requested_at
    or old.status <> 'pending' then
    raise exception 'Approval request identity and decisions are immutable.';
  end if;
  return new;
end;
$$;
create trigger campaign_action_approval_identity
  before update on public.campaign_action_approvals
  for each row execute function public.guard_campaign_action_approval_identity();

alter table public.campaign_action_approvals enable row level security;
create policy campaign_action_approvals_read on public.campaign_action_approvals
  for select to authenticated using (
    public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id)
  );
grant select on public.campaign_action_approvals to authenticated;

create function public.request_campaign_action_approval_v6(
  p_manifest_id uuid, p_idempotency_key text, p_action_key text,
  p_destination text, p_artifact_version_hash text, p_scope jsonb
) returns public.campaign_action_approvals
language plpgsql volatile security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
  v_manifest public.campaign_manifest_versions%rowtype;
  v_request public.campaign_action_approvals%rowtype;
  v_hash text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service can request an external action.';
  end if;
  select * into v_manifest from public.campaign_manifest_versions
    where id = p_manifest_id;
  if not found then raise exception 'Campaign package not found.'; end if;
  if exists (select 1 from public.campaign_manifest_versions v
    where v.campaign_id = v_manifest.campaign_id and v.version > v_manifest.version) then
    raise exception 'Campaign package was superseded.';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 160
     or p_action_key is null or p_action_key not in (
       'campaign_launch', 'meta_ad_build', 'google_ad_build', 'organic_publish',
       'proof_publish', 'page_deploy', 'lead_message', 'profile_update', 'budget_change')
     or p_destination is null or length(btrim(p_destination)) not between 1 and 300
     or p_artifact_version_hash is null or p_artifact_version_hash !~ '^[0-9a-f]{32,128}$'
     or p_scope is null or jsonb_typeof(p_scope) <> 'object' then
    raise exception 'An action, destination, exact version and scope are required.';
  end if;
  if p_action_key = 'campaign_launch' and p_artifact_version_hash <> v_manifest.plan_hash then
    raise exception 'Campaign launch must reference the exact package hash.';
  end if;
  if (p_action_key in ('meta_ad_build', 'google_ad_build')
      and (v_manifest.acquisition_mode <> 'paid'
        or p_action_key <> v_manifest.paid_platform || '_ad_build'))
     or (p_action_key = 'organic_publish' and v_manifest.acquisition_mode <> 'organic') then
    raise exception 'External action does not match the campaign route.';
  end if;
  v_hash := md5(jsonb_build_object(
    'manifest_id', p_manifest_id, 'action_key', p_action_key,
    'destination', btrim(p_destination),
    'artifact_version_hash', p_artifact_version_hash, 'scope', p_scope
  )::text);
  perform pg_advisory_xact_lock(hashtextextended(
    v_manifest.campaign_id::text || ':action:' || btrim(p_idempotency_key), 0));
  select * into v_request from public.campaign_action_approvals
    where campaign_id = v_manifest.campaign_id and idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_request.request_hash <> v_hash then
      raise exception 'Idempotency key already belongs to a different action.';
    end if;
    return v_request;
  end if;
  insert into public.campaign_action_approvals (
    client_id, campaign_id, manifest_id, idempotency_key, action_key,
    destination, artifact_version_hash, scope, request_hash
  ) values (
    v_manifest.client_id, v_manifest.campaign_id, v_manifest.id,
    btrim(p_idempotency_key), p_action_key, btrim(p_destination),
    p_artifact_version_hash, p_scope, v_hash
  ) returning * into v_request;
  return v_request;
end;
$$;

create function public.decide_campaign_action_approval_v6(
  p_request_id uuid, p_decision text, p_reason text default null
) returns public.campaign_action_approvals
language plpgsql volatile security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
  v_request public.campaign_action_approvals%rowtype;
  v_manifest public.campaign_manifest_versions%rowtype;
begin
  if auth.role() <> 'authenticated' or auth.uid() is null then
    raise exception 'A signed-in human must decide this action.';
  end if;
  select * into v_request from public.campaign_action_approvals
    where id = p_request_id for update;
  if not found then raise exception 'Approval request not found.'; end if;
  if not (coalesce(public.is_admin(), false)
    or coalesce(auth.uid() = public.active_video_approval_manager(v_request.client_id), false)) then
    raise exception 'Only an admin or the active client manager may approve.';
  end if;
  if v_request.status <> 'pending' then
    raise exception 'This request has already been decided.';
  end if;
  select * into v_manifest from public.campaign_manifest_versions
    where id = v_request.manifest_id;
  if exists (select 1 from public.campaign_manifest_versions v
    where v.campaign_id = v_request.campaign_id and v.version > v_manifest.version) then
    raise exception 'The campaign package changed. Request a new approval.';
  end if;
  if p_decision not in ('approved', 'rejected') or p_decision is null
     or (p_decision = 'rejected' and nullif(btrim(coalesce(p_reason, '')), '') is null) then
    raise exception 'Approve, or reject with a reason.';
  end if;
  update public.campaign_action_approvals set
    status = p_decision, decided_at = now(), decided_by = auth.uid(),
    rejection_reason = case when p_decision = 'rejected' then btrim(p_reason) else null end
  where id = p_request_id returning * into v_request;
  return v_request;
end;
$$;

revoke all on function public.request_campaign_action_approval_v6(uuid, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.request_campaign_action_approval_v6(uuid, text, text, text, text, jsonb)
  to service_role;
revoke all on function public.decide_campaign_action_approval_v6(uuid, text, text)
  from public, anon, service_role;
grant execute on function public.decide_campaign_action_approval_v6(uuid, text, text)
  to authenticated;

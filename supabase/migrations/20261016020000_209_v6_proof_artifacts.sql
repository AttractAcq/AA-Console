-- Proof derivatives are versioned internal drafts. Approval records claim QA;
-- publication remains a separate, human-approved external action.
alter table public.client_proof_assets
  add column permission_basis text,
  add constraint proof_permission_basis_length_v6 check (
    permission_basis is null or length(btrim(permission_basis)) between 1 and 2000
  );

create function public.require_new_proof_permission_v6()
returns trigger language plpgsql as $$
begin
  if new.usage_rights = 'approved'
     and nullif(btrim(new.permission_basis), '') is null then
    raise exception 'Record the permission basis before clearing proof for use.';
  end if;
  return new;
end;
$$;
create trigger proof_new_permission_v6 before insert on public.client_proof_assets
  for each row execute function public.require_new_proof_permission_v6();

create table public.proof_rights_events (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  proof_id uuid not null references public.client_proof_assets(id) on delete cascade,
  previous_rights text not null,
  new_rights text not null,
  previous_expiry date,
  new_expiry date,
  permission_basis text,
  actor_id uuid references public.profiles(id),
  actor_role text not null,
  changed_at timestamptz not null default now()
);

create function public.record_proof_rights_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if new.client_id <> old.client_id then
    raise exception 'A proof source cannot move between clients.';
  end if;
  if new.usage_rights = 'approved' and (
    old.usage_rights is distinct from 'approved'
    or new.permission_basis is distinct from old.permission_basis
  ) and nullif(btrim(new.permission_basis), '') is null then
    raise exception 'Record the permission basis before clearing proof for use.';
  end if;
  if new.usage_rights is distinct from old.usage_rights
     or new.expires_on is distinct from old.expires_on
     or new.permission_basis is distinct from old.permission_basis then
    insert into public.proof_rights_events (
      client_id, proof_id, previous_rights, new_rights,
      previous_expiry, new_expiry, permission_basis, actor_id, actor_role
    ) values (
      new.client_id, new.id, old.usage_rights, new.usage_rights,
      old.expires_on, new.expires_on, new.permission_basis, auth.uid(),
      coalesce(auth.role(), 'unknown')
    );
  end if;
  return new;
end;
$$;
create trigger proof_rights_audit_v6 after update on public.client_proof_assets
  for each row execute function public.record_proof_rights_v6();

alter table public.proof_rights_events enable row level security;
create policy proof_rights_events_read_v6 on public.proof_rights_events for select to authenticated
  using (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
grant select on public.proof_rights_events to authenticated;
create policy proof_manager_update_v6 on public.client_proof_assets for update to authenticated
  using (auth.uid() = public.active_video_approval_manager(client_id))
  with check (auth.uid() = public.active_video_approval_manager(client_id));
-- The legacy client-upload policy allowed callers to supply usage_rights on
-- INSERT instead of relying on its safe default. A client may file evidence,
-- but cannot grant its own public-use permission through that upload path.
drop policy if exists cpa_client_insert on public.client_proof_assets;
create policy cpa_client_insert on public.client_proof_assets for insert to authenticated
  with check (public.can_access_client(client_id) and usage_rights = 'not_cleared');

create table public.proof_artifact_versions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  source_proof_id uuid not null references public.client_proof_assets(id),
  artifact_kind text not null check (artifact_kind in
    ('geo_answer', 'seo_case_study', 'local_proof_snippet')),
  version integer not null check (version > 0),
  idempotency_key text not null check (length(btrim(idempotency_key)) between 1 and 160),
  source_snapshot jsonb not null check (jsonb_typeof(source_snapshot) = 'object'),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  supported_claim text not null check (length(btrim(supported_claim)) between 1 and 1000),
  evidence_excerpt text not null check (length(btrim(evidence_excerpt)) between 1 and 2000),
  content text not null check (length(btrim(content)) between 1 and 12000),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_by_job_id uuid references public.agent_jobs(id),
  created_at timestamptz not null default now(),
  unique (source_proof_id, artifact_kind, version),
  unique (client_id, idempotency_key),
  unique (id, client_id)
);

create table public.proof_artifact_signoffs (
  artifact_version_id uuid primary key,
  client_id uuid not null,
  approved_by uuid not null references public.profiles(id),
  approved_at timestamptz not null default now(),
  foreign key (artifact_version_id, client_id)
    references public.proof_artifact_versions(id, client_id) on delete cascade
);

create index proof_artifact_client_source_idx
  on public.proof_artifact_versions(client_id, source_proof_id, created_at desc);

create function public.proof_source_snapshot_v6(p public.client_proof_assets)
returns jsonb language sql immutable set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'id', p.id, 'client_id', p.client_id, 'title', p.title,
    'body', p.body, 'source', p.source, 'proof_type', p.proof_type,
    'claim', p.claim, 'evidence', p.evidence,
    'captured_on', p.captured_on, 'storage_path', p.storage_path
  );
$$;

create function public.proof_snapshot_hash_v6(p jsonb)
returns text language sql immutable set search_path = pg_catalog, public as $$
  select encode(sha256(convert_to(p::text, 'UTF8')), 'hex');
$$;

create function public.guard_proof_artifact_immutable_v6()
returns trigger language plpgsql as $$
begin
  raise exception 'Proof artifacts and sign-offs are immutable. Create a new version.';
end;
$$;
create trigger proof_artifact_versions_immutable before update on public.proof_artifact_versions
  for each row execute function public.guard_proof_artifact_immutable_v6();
create trigger proof_artifact_signoffs_immutable before update on public.proof_artifact_signoffs
  for each row execute function public.guard_proof_artifact_immutable_v6();

alter table public.proof_artifact_versions enable row level security;
alter table public.proof_artifact_signoffs enable row level security;
create policy proof_artifacts_read_v6 on public.proof_artifact_versions for select to authenticated
  using (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
create policy proof_artifact_signoffs_read_v6 on public.proof_artifact_signoffs for select to authenticated
  using (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
grant select on public.proof_artifact_versions, public.proof_artifact_signoffs to authenticated;

create function public.create_proof_artifact_v6(
  p_client_id uuid, p_source_proof_id uuid, p_artifact_kind text,
  p_supported_claim text, p_evidence_excerpt text, p_content text,
  p_idempotency_key text, p_job_id uuid default null
) returns public.proof_artifact_versions
language plpgsql volatile security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
  v_proof public.client_proof_assets%rowtype;
  v_snapshot jsonb;
  v_source_hash text;
  v_content_hash text;
  v_artifact public.proof_artifact_versions%rowtype;
begin
  if auth.role() <> 'service_role' and not (
    auth.role() = 'authenticated' and
    (coalesce(public.is_admin(), false) or
      coalesce(auth.uid() = public.active_video_approval_manager(p_client_id), false))
  ) then raise exception 'Only the client manager or an admin can draft a proof artifact.'; end if;
  if p_job_id is not null and auth.role() <> 'service_role' then
    raise exception 'Only the internal service may link an agent job.';
  end if;
  if p_job_id is not null and not exists (
    select 1 from public.agent_jobs j
    where j.id = p_job_id and j.client_id = p_client_id
      and j.agent_key = 'proof_artifact'
  ) then raise exception 'A matching proof artifact job is required.'; end if;
  if p_artifact_kind not in ('geo_answer','seo_case_study','local_proof_snippet')
     or p_supported_claim is null or length(btrim(p_supported_claim)) not between 1 and 1000
     or p_evidence_excerpt is null or length(btrim(p_evidence_excerpt)) not between 1 and 2000
     or p_content is null or length(btrim(p_content)) not between 1 and 12000
     or p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 160 then
    raise exception 'A kind, claim, evidence excerpt, content and request key are required.';
  end if;
  select * into v_proof from public.client_proof_assets
    where id = p_source_proof_id and client_id = p_client_id for share;
  if not found then raise exception 'Proof source does not belong to this client.'; end if;
  if nullif(btrim(v_proof.evidence), '') is null
     and nullif(btrim(v_proof.body), '') is null then
    raise exception 'Proof source needs readable evidence before a text artifact can be drafted.';
  end if;
  if strpos(coalesce(v_proof.evidence, '') || E'\n' || coalesce(v_proof.body, ''),
    btrim(p_evidence_excerpt)) = 0 then
    raise exception 'Evidence excerpt must appear verbatim in the source proof.';
  end if;
  v_snapshot := public.proof_source_snapshot_v6(v_proof);
  v_source_hash := public.proof_snapshot_hash_v6(v_snapshot);
  v_content_hash := public.proof_snapshot_hash_v6(jsonb_build_object(
    'source_hash', v_source_hash, 'kind', p_artifact_kind,
    'claim', btrim(p_supported_claim), 'excerpt', btrim(p_evidence_excerpt),
    'content', btrim(p_content)));
  perform pg_advisory_xact_lock(hashtextextended(
    p_client_id::text || ':proof-artifact:' || btrim(p_idempotency_key), 0));
  select * into v_artifact from public.proof_artifact_versions
    where client_id = p_client_id and idempotency_key = btrim(p_idempotency_key);
  if found then
    if v_artifact.content_hash <> v_content_hash
       or v_artifact.source_proof_id <> p_source_proof_id
       or v_artifact.created_by_job_id is distinct from p_job_id then
      raise exception 'Idempotency key already belongs to a different artifact.';
    end if;
    return v_artifact;
  end if;
  insert into public.proof_artifact_versions (
    client_id, source_proof_id, artifact_kind, version, idempotency_key,
    source_snapshot, source_hash, supported_claim, evidence_excerpt,
    content, content_hash, created_by_job_id
  ) values (
    p_client_id, p_source_proof_id, p_artifact_kind,
    coalesce((select max(version) + 1 from public.proof_artifact_versions
      where source_proof_id = p_source_proof_id and artifact_kind = p_artifact_kind), 1),
    btrim(p_idempotency_key), v_snapshot, v_source_hash,
    btrim(p_supported_claim), btrim(p_evidence_excerpt), btrim(p_content),
    v_content_hash, p_job_id
  ) returning * into v_artifact;
  return v_artifact;
end;
$$;

create function public.approve_proof_artifact_v6(p_artifact_version_id uuid)
returns public.proof_artifact_signoffs
language plpgsql volatile security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
  v_artifact public.proof_artifact_versions%rowtype;
  v_proof public.client_proof_assets%rowtype;
  v_signoff public.proof_artifact_signoffs%rowtype;
begin
  if auth.role() <> 'authenticated' or auth.uid() is null then
    raise exception 'A signed-in human must approve a proof artifact.';
  end if;
  select * into v_artifact from public.proof_artifact_versions where id = p_artifact_version_id;
  if not found then raise exception 'Proof artifact not found.'; end if;
  if not (coalesce(public.is_admin(), false) or
    coalesce(auth.uid() = public.active_video_approval_manager(v_artifact.client_id), false)) then
    raise exception 'Only an admin or the active client manager may approve.';
  end if;
  select * into v_proof from public.client_proof_assets
    where id = v_artifact.source_proof_id and client_id = v_artifact.client_id for share;
  if not found or v_proof.usage_rights <> 'approved'
     or nullif(btrim(v_proof.permission_basis), '') is null
     or (v_proof.expires_on is not null and v_proof.expires_on < current_date)
     or public.proof_snapshot_hash_v6(public.proof_source_snapshot_v6(v_proof)) <> v_artifact.source_hash then
    raise exception 'The proof source is uncleared, expired or changed. Refresh the artifact.';
  end if;
  if exists (select 1 from public.proof_artifact_signoffs
    where artifact_version_id = p_artifact_version_id) then
    raise exception 'This proof artifact is already approved.';
  end if;
  insert into public.proof_artifact_signoffs(artifact_version_id, client_id, approved_by)
  values (p_artifact_version_id, v_artifact.client_id, auth.uid()) returning * into v_signoff;
  return v_signoff;
end;
$$;

revoke all on function public.create_proof_artifact_v6(uuid,uuid,text,text,text,text,text,uuid)
  from public, anon;
grant execute on function public.create_proof_artifact_v6(uuid,uuid,text,text,text,text,text,uuid)
  to authenticated, service_role;
revoke all on function public.approve_proof_artifact_v6(uuid)
  from public, anon, service_role;
grant execute on function public.approve_proof_artifact_v6(uuid) to authenticated;

insert into public.agents (
  agent_key, name, initials, domain, description, requires_upstream, requires_input
) values (
  'proof_artifact', 'Proof Artifact Builder', 'PA', 'content',
  'Turns one genuine proof source into a reviewable GEO or SEO artifact without clearing it for publication.',
  '{}', false
) on conflict (agent_key) do nothing;

create function public.request_proof_artifact_v6(
  p_client_id uuid, p_source_proof_id uuid, p_artifact_kind text
) returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.role() <> 'authenticated' or not (
    coalesce(public.is_admin(), false) or
    coalesce(auth.uid() = public.active_video_approval_manager(p_client_id), false)
  ) then raise exception 'Only the client manager or an admin can request proof generation.'; end if;
  if p_artifact_kind not in ('geo_answer','seo_case_study','local_proof_snippet') then
    raise exception 'Choose a supported proof artifact type.';
  end if;
  if not exists (select 1 from public.client_proof_assets
    where id = p_source_proof_id and client_id = p_client_id
      and (nullif(btrim(evidence), '') is not null or nullif(btrim(body), '') is not null)) then
    raise exception 'Choose a same-client proof source with readable evidence.';
  end if;
  return public.enqueue_agent_job_internal(
    'proof_artifact', p_client_id, 'client_proof_assets', p_source_proof_id,
    auth.uid(), jsonb_build_object(
      'source_proof_id', p_source_proof_id,
      'artifact_kind', p_artifact_kind
    ), 'Queued proof artifact draft'
  );
end;
$$;
revoke all on function public.request_proof_artifact_v6(uuid,uuid,text)
  from public, anon, service_role;
grant execute on function public.request_proof_artifact_v6(uuid,uuid,text)
  to authenticated;

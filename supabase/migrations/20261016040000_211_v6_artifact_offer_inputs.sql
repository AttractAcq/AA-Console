-- Freeze the offer a campaign page or sales agent saw when its build job ran.
-- A standalone or legacy artifact still uses its historical strategy input.
create table public.campaign_artifact_offer_inputs (
  job_id uuid primary key references public.agent_jobs(id) on delete cascade,
  client_id uuid not null,
  campaign_id uuid not null,
  manifest_id uuid not null,
  artifact_kind text not null check (artifact_kind in ('page', 'sales_agent')),
  artifact_id uuid not null,
  offer_version_id uuid not null,
  offer_snapshot jsonb not null check (jsonb_typeof(offer_snapshot) = 'object'),
  captured_at timestamptz not null default now(),
  foreign key (manifest_id, campaign_id, client_id)
    references public.campaign_manifest_versions(id, campaign_id, client_id) on delete restrict,
  foreign key (offer_version_id, client_id)
    references public.service_offer_versions(id, client_id) on delete restrict
);

create trigger campaign_artifact_offer_inputs_immutable
  before update on public.campaign_artifact_offer_inputs
  for each row execute function public.guard_campaign_manifest_immutable();
alter table public.campaign_artifact_offer_inputs enable row level security;
create policy campaign_artifact_offer_inputs_read
  on public.campaign_artifact_offer_inputs for select to authenticated
  using (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
grant select on public.campaign_artifact_offer_inputs to authenticated;

-- Existing Offer Studio packages may have selected their approved version
-- after planning. Read that exact package link too, with the same live rights
-- checks as a preselected campaign offer.
create function public.capture_offer_version_for_artifact_v6(
  p_campaign_id uuid, p_offer_version_id uuid
) returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
  v_campaign public.client_campaigns%rowtype;
  v_version public.service_offer_versions%rowtype;
  v_service text;
  v_claim jsonb;
  v_proof public.client_proof_assets%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  select * into v_campaign from public.client_campaigns where id = p_campaign_id;
  select * into v_version from public.service_offer_versions
    where id = p_offer_version_id and client_id = v_campaign.client_id;
  if v_campaign.id is null or v_version.id is null or not exists (
    select 1 from public.service_offer_signoffs
    where offer_version_id = v_version.id and client_id = v_campaign.client_id
  ) then raise exception 'An approved same-client offer version is required.'; end if;
  select service_name into v_service from public.service_offers
    where id = v_version.offer_id and client_id = v_version.client_id;
  for v_claim in select * from jsonb_array_elements(v_version.claims) loop
    if v_claim->>'kind' = 'quantified' then
      select * into v_proof from public.client_proof_assets
        where id = (v_claim->>'proof_asset_id')::uuid;
      if not found or v_proof.client_id <> v_version.client_id
         or v_proof.usage_rights <> 'approved'
         or (v_proof.expires_on is not null and v_proof.expires_on < current_date) then
        raise exception 'A quantified offer claim needs current, cleared proof for this client.';
      end if;
    end if;
  end loop;
  return jsonb_build_object(
    'id', v_version.id, 'offer_id', v_version.offer_id,
    'service_name', v_service, 'version', v_version.version,
    'audience', v_version.audience, 'promise', v_version.promise,
    'inclusions', v_version.inclusions, 'exclusions', v_version.exclusions,
    'price_amount', v_version.price_amount, 'currency', v_version.currency,
    'claims', v_version.claims, 'content_hash', v_version.content_hash
  );
end;
$$;
revoke all on function public.capture_offer_version_for_artifact_v6(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.capture_offer_version_for_artifact_v6(uuid, uuid)
  to service_role;

create function public.capture_campaign_artifact_offer_v6(
  p_job_id uuid, p_artifact_kind text
) returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
  v_job public.agent_jobs%rowtype;
  v_link public.campaign_artifacts%rowtype;
  v_campaign public.client_campaigns%rowtype;
  v_manifest public.campaign_manifest_versions%rowtype;
  v_existing public.campaign_artifact_offer_inputs%rowtype;
  v_offer jsonb;
  v_offer_version_id uuid;
  v_expected_table text;
  v_expected_agent text;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  if p_artifact_kind not in ('page', 'sales_agent') then
    raise exception 'Choose page or sales_agent.';
  end if;
  v_expected_table := case when p_artifact_kind = 'page'
    then 'client_pages' else 'client_sales_agents' end;
  v_expected_agent := case when p_artifact_kind = 'page'
    then 'landing_page' else 'sales_agent' end;
  select * into v_job from public.agent_jobs where id = p_job_id;
  if not found or v_job.client_id is null or v_job.input_id is null
     or v_job.input_table <> v_expected_table
     or v_job.agent_key <> v_expected_agent then
    raise exception 'A matching artifact build job is required.';
  end if;
  if p_artifact_kind = 'page' and not exists (
      select 1 from public.client_pages p
      where p.id = v_job.input_id and p.client_id = v_job.client_id
    ) or p_artifact_kind = 'sales_agent' and not exists (
      select 1 from public.client_sales_agents s
      where s.id = v_job.input_id and s.client_id = v_job.client_id
    ) then
    raise exception 'Artifact does not belong to this job client.';
  end if;
  if (select count(*) from public.campaign_artifacts a
      where a.client_id = v_job.client_id and
        (p_artifact_kind = 'page' and a.kind = 'landing_page' and a.page_id = v_job.input_id
        or p_artifact_kind = 'sales_agent' and a.kind = 'sales_agent'
          and a.sales_agent_id = v_job.input_id)) > 1 then
    raise exception 'An artifact linked to multiple campaigns has ambiguous offer scope.';
  end if;
  select * into v_link from public.campaign_artifacts a
    where a.client_id = v_job.client_id and
      (p_artifact_kind = 'page' and a.kind = 'landing_page' and a.page_id = v_job.input_id
      or p_artifact_kind = 'sales_agent' and a.kind = 'sales_agent'
        and a.sales_agent_id = v_job.input_id);
  if not found then return null; end if;
  select * into v_campaign from public.client_campaigns c
    where c.id = v_link.campaign_id and c.client_id = v_job.client_id;
  if not found then raise exception 'Campaign link has a different client.'; end if;
  if v_campaign.acquisition_mode = 'legacy' then
    return null;
  end if;
  select * into v_manifest from public.campaign_manifest_versions m
    where m.campaign_id = v_campaign.id
    order by m.version desc limit 1;
  if not found then
    raise exception 'Plan the campaign before building its artifacts.';
  end if;
  select offer_version_id into v_offer_version_id
    from public.campaign_manifest_offers where manifest_id = v_manifest.id;
  if v_offer_version_id is null then
    if v_campaign.offer_version_id is not null then
      raise exception 'Link the selected approved offer to the current package first.';
    end if;
    return null;
  end if;
  if v_campaign.offer_version_id is not null
     and v_campaign.offer_version_id <> v_offer_version_id then
    raise exception 'Campaign and package use different offer versions.';
  end if;
  v_offer := public.capture_offer_version_for_artifact_v6(
    v_campaign.id, v_offer_version_id);
  select * into v_existing from public.campaign_artifact_offer_inputs
    where job_id = p_job_id;
  if found then
    if v_existing.artifact_kind <> p_artifact_kind
       or v_existing.artifact_id <> v_job.input_id
       or v_existing.campaign_id <> v_campaign.id
       or v_existing.manifest_id <> v_manifest.id
       or v_existing.offer_snapshot <> v_offer then
      raise exception 'Artifact offer input changed on retry; enqueue a new build.';
    end if;
    return v_existing.offer_snapshot;
  end if;
  insert into public.campaign_artifact_offer_inputs (
    job_id, client_id, campaign_id, manifest_id, artifact_kind,
    artifact_id, offer_version_id, offer_snapshot
  ) values (
    p_job_id, v_job.client_id, v_campaign.id, v_manifest.id,
    p_artifact_kind, v_job.input_id, v_offer_version_id, v_offer
  );
  return v_offer;
end;
$$;
revoke all on function public.capture_campaign_artifact_offer_v6(uuid, text)
  from public, anon, authenticated;
grant execute on function public.capture_campaign_artifact_offer_v6(uuid, text)
  to service_role;

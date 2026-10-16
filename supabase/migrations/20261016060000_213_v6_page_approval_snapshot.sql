-- Capture a reviewable page revision and destination before a human decides.
-- This deliberately does not publish: the later executor must compare this
-- snapshot to the current page, repository, campaign package and approval.
create table public.campaign_page_approval_snapshots (
  approval_id uuid primary key references public.campaign_action_approvals(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  page_id uuid not null references public.client_pages(id) on delete cascade,
  revision_id uuid not null references public.client_page_revisions(id) on delete restrict,
  site_repository_id uuid not null references public.client_site_repositories(id) on delete restrict,
  site_path text not null,
  rendered_html text not null,
  rendered_sha256 text not null check (rendered_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create function public.guard_campaign_page_approval_snapshot_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'Page approval snapshots are immutable. Request a new approval.';
end;
$$;
create trigger campaign_page_approval_snapshot_immutable
  before update on public.campaign_page_approval_snapshots
  for each row execute function public.guard_campaign_page_approval_snapshot_immutable();

alter table public.campaign_page_approval_snapshots enable row level security;
create policy campaign_page_approval_snapshot_read
  on public.campaign_page_approval_snapshots for select to authenticated
  using (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
grant select on public.campaign_page_approval_snapshots to authenticated;

-- A generic page_deploy request has no reviewable HTML snapshot. It must not
-- become an approval, and a prepared request becomes stale when its page or
-- destination changes before the human decision.
create function public.guard_campaign_page_deploy_decision_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_snapshot public.campaign_page_approval_snapshots%rowtype;
  v_page public.client_pages%rowtype;
  v_repo public.client_site_repositories%rowtype;
begin
  if old.action_key <> 'page_deploy' or new.status <> 'approved' then
    return new;
  end if;
  select * into v_snapshot from public.campaign_page_approval_snapshots
    where approval_id = old.id;
  if not found then raise exception 'Page approval requires an exact rendered snapshot.'; end if;
  select * into v_page from public.client_pages where id = v_snapshot.page_id;
  select * into v_repo from public.client_site_repositories
    where id = v_snapshot.site_repository_id;
  if v_page.id is null or v_repo.id is null
     or v_page.client_id <> old.client_id or v_repo.client_id <> old.client_id
     or v_snapshot.client_id <> old.client_id
     or v_snapshot.rendered_sha256 <> old.artifact_version_hash
     or v_snapshot.rendered_sha256 <>
       encode(sha256(convert_to(v_snapshot.rendered_html, 'UTF8')), 'hex')
     or v_page.site_repository_id is distinct from v_snapshot.site_repository_id
     or v_page.site_path is distinct from v_snapshot.site_path
     or v_page.html is distinct from v_snapshot.rendered_html
     or not exists (select 1 from public.client_page_revisions r
       where r.id = v_snapshot.revision_id and r.page_id = v_page.id
         and r.revision_number = v_page.current_revision)
     or v_page.publish_status in ('publishing', 'published')
     or v_page.published_url is not null
     or v_repo.status <> 'ready'
     or v_repo.pages_url is null
     or old.destination <> rtrim(v_repo.pages_url, '/') || '/' ||
       replace(v_snapshot.site_path, 'index.html', '')
     or exists (select 1 from public.client_sales_agent_deployments
       where page_id = v_page.id) then
    raise exception 'Page or destination changed. Request a new approval.';
  end if;
  return new;
end;
$$;
create trigger campaign_page_deploy_decision_guard_v6
  before update of status on public.campaign_action_approvals
  for each row execute function public.guard_campaign_page_deploy_decision_v6();

create function public.request_campaign_page_deploy_approval_v6(
  p_page_id uuid, p_idempotency_key text,
  p_site_repository_id uuid default null, p_site_path text default null
) returns public.campaign_action_approvals
language plpgsql volatile security definer
set search_path = pg_catalog, public
set timezone = 'UTC'
as $$
declare
  v_page public.client_pages%rowtype;
  v_repo public.client_site_repositories%rowtype;
  v_revision public.client_page_revisions%rowtype;
  v_campaign_id uuid;
  v_manifest public.campaign_manifest_versions%rowtype;
  v_approval public.campaign_action_approvals%rowtype;
  v_url text;
  v_hash text;
  v_repo_id uuid;
  v_path text;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required.'; end if;
  select * into v_page from public.client_pages where id = p_page_id for update;
  if not found then raise exception 'Page not found.'; end if;
  if nullif(btrim(coalesce(v_page.html, '')), '') is null
     or v_page.current_revision is null then
    raise exception 'A built, versioned page is required.';
  end if;
  if v_page.publish_status in ('publishing', 'published')
     or v_page.published_url is not null then
    raise exception 'A live page cannot request a new v6 deployment approval.';
  end if;
  select * into v_revision from public.client_page_revisions
    where page_id = p_page_id and revision_number = v_page.current_revision
      and client_id = v_page.client_id;
  if not found or v_revision.html is distinct from v_page.html then
    raise exception 'Current page HTML does not match its recorded revision.';
  end if;
  if exists (select 1 from public.client_sales_agent_deployments
    where page_id = p_page_id) then
    raise exception 'Sales-agent widgets need their own exact-render approval path.';
  end if;
  if v_page.site_repository_id is not null and p_site_repository_id is not null
     and v_page.site_repository_id <> p_site_repository_id then
    raise exception 'Page is already assigned to a different site.';
  end if;
  if v_page.site_path is not null and p_site_path is not null
     and v_page.site_path <> p_site_path then
    raise exception 'Page is already assigned to a different path.';
  end if;
  v_repo_id := coalesce(v_page.site_repository_id, p_site_repository_id);
  v_path := coalesce(v_page.site_path, p_site_path);
  select * into v_repo from public.client_site_repositories
    where id = v_repo_id and client_id = v_page.client_id
      and status = 'ready' and pages_url is not null;
  if not found or v_path is null
     or v_repo.pages_url !~ '^https://[^[:space:]]+$'
     or v_path !~ '^[a-z0-9][a-z0-9-]{0,59}/index[.]html$'
     or split_part(v_path, '/', 1) in ('aa', 'assets', 'api', 'docs') then
    raise exception 'A ready same-client site and safe page destination are required.';
  end if;
  if (select count(distinct a.campaign_id) from public.campaign_artifacts a
      join public.client_campaigns c on c.id = a.campaign_id
      where a.page_id = p_page_id and a.kind = 'landing_page'
        and a.client_id = v_page.client_id
        and c.acquisition_mode in ('organic', 'paid')) <> 1 then
    raise exception 'Page must belong to exactly one v6 campaign.';
  end if;
  select a.campaign_id into v_campaign_id from public.campaign_artifacts a
    join public.client_campaigns c on c.id = a.campaign_id
    where a.page_id = p_page_id and a.kind = 'landing_page'
      and a.client_id = v_page.client_id
      and c.acquisition_mode in ('organic', 'paid') limit 1;
  select * into v_manifest from public.campaign_manifest_versions
    where campaign_id = v_campaign_id order by version desc limit 1;
  if not found then raise exception 'Campaign package is required.'; end if;
  if nullif(btrim(coalesce(p_idempotency_key, '')), '') is null then
    raise exception 'An idempotency key is required.';
  end if;

  update public.client_pages set site_repository_id = v_repo_id,
    site_path = v_path where id = v_page.id;
  v_url := rtrim(v_repo.pages_url, '/') || '/' ||
    replace(v_path, 'index.html', '');
  v_hash := encode(sha256(convert_to(v_page.html, 'UTF8')), 'hex');
  v_approval := public.request_campaign_action_approval_v6(
    v_manifest.id, left(btrim(p_idempotency_key), 120) || ':' || v_manifest.id,
    'page_deploy', v_url, v_hash,
    jsonb_build_object(
      'page_id', p_page_id, 'revision_id', v_revision.id,
      'revision_number', v_revision.revision_number,
      'site_repository_id', v_repo.id, 'site_path', v_path,
      'owner', v_repo.owner, 'repository', v_repo.repo,
      'default_branch', v_repo.default_branch,
      'rendered_sha256', v_hash
    )
  );
  insert into public.campaign_page_approval_snapshots (
    approval_id, client_id, page_id, revision_id, site_repository_id,
    site_path, rendered_html, rendered_sha256
  ) values (
    v_approval.id, v_page.client_id, v_page.id, v_revision.id, v_repo.id,
    v_path, v_page.html, v_hash
  ) on conflict (approval_id) do nothing;
  if not exists (select 1 from public.campaign_page_approval_snapshots s
    where s.approval_id = v_approval.id and s.page_id = v_page.id
      and s.revision_id = v_revision.id and s.rendered_sha256 = v_hash) then
    raise exception 'Approval replay does not match its page snapshot.';
  end if;
  return v_approval;
end;
$$;
revoke all on function public.request_campaign_page_deploy_approval_v6(uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.request_campaign_page_deploy_approval_v6(uuid, text, uuid, text)
  to service_role;

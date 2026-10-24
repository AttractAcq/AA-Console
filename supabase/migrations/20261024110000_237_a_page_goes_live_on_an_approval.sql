-- Migration 212 blocked v6 campaign pages from publishing "until its
-- exact-version approval executor exists". It exists now.
--
-- 212's guard, 213's reviewable snapshot and the decision guard that makes a
-- stale request undecidable were all built against this moment. What was
-- missing was the thing that reads an approval and commits the bytes, and a
-- way for the publisher to tell the difference between a publish somebody
-- approved and one that merely arrived through a different door.
--
-- SO THE BLOCK IS NOT LIFTED. IT IS GIVEN ONE KEY.
--
-- `assert_page_publish_allowed_v6` is untouched: the admin route, the MCP
-- route and the legacy publisher still cannot put a v6 campaign page live,
-- and the reverse route of attaching a live page to a v6 campaign is still
-- closed. What this adds is a second function the executor calls instead,
-- which permits exactly one publish: this page, under this approval, at the
-- revision and byte hash a person actually read.
--
-- The check is deliberately narrow and re-run at the write rather than
-- trusted from the decision:
--
--   the approval is approved, is a page_deploy, and is for this page
--   its snapshot names the revision the page is currently built from
--   the page's current HTML still hashes to what the snapshot recorded
--   no later package version has superseded the one it was approved against
--
-- The third of those is the one that matters. A snapshot records what was
-- reviewed; it cannot stop somebody regenerating the page afterwards. Without
-- re-hashing, "the exact bytes a person approved" means "a page id a person
-- approved".
--
-- WHAT GOING LIVE DOES NOT MEAN
--
-- That the form works. A published page whose form posts nowhere is the
-- failure this module exists to prevent, and it looks identical to a working
-- one from the outside. So publication records a commit and nothing more; the
-- probe in 238 is what lets a page call itself live.

update public.campaign_action_executors
   set supported = true,
       note = 'Publishes the exact reviewed bytes to the client site repository, re-hashing the page against the approved snapshot immediately before the commit. Does not prove the form works: that is the probe.'
 where action_key = 'page_deploy';

-- ---------------------------------------------------------------------------
-- The one key
-- ---------------------------------------------------------------------------

create function public.assert_page_publish_by_approval_v6(
  p_approval_id uuid, p_page_id uuid, p_current_html text)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_approval public.campaign_action_approvals%rowtype;
  v_snapshot public.campaign_page_approval_snapshots%rowtype;
  v_page public.client_pages%rowtype;
  v_manifest public.campaign_manifest_versions%rowtype;
  v_hash text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may publish an approved page.';
  end if;

  select * into v_approval from public.campaign_action_approvals where id = p_approval_id;
  if not found then raise exception 'No such approval.'; end if;
  if v_approval.action_key <> 'page_deploy' then
    raise exception 'That approval is a %, not a page deployment.', v_approval.action_key;
  end if;
  if v_approval.status <> 'approved' then
    raise exception 'That page deployment is %, not approved.', v_approval.status;
  end if;

  select * into v_snapshot from public.campaign_page_approval_snapshots
   where approval_id = p_approval_id;
  if not found then
    -- 213 refuses to let a snapshotless page_deploy be approved at all, so
    -- this is belt and braces rather than a reachable state.
    raise exception 'That approval has no reviewable snapshot.';
  end if;
  if v_snapshot.page_id <> p_page_id then
    raise exception 'That approval is for a different page.';
  end if;

  select * into v_page from public.client_pages where id = p_page_id;
  if not found then raise exception 'Page not found.'; end if;

  -- Superseded package: the campaign has moved on since somebody read this.
  select * into v_manifest from public.campaign_manifest_versions
   where id = v_approval.manifest_id;
  if exists (select 1 from public.campaign_manifest_versions v
              where v.campaign_id = v_approval.campaign_id and v.version > v_manifest.version) then
    raise exception 'The campaign package was superseded after this page was approved. Request approval again.';
  end if;

  -- The bytes. A snapshot records what was reviewed; only this stops somebody
  -- regenerating the page between the yes and the commit.
  if p_current_html is null or length(p_current_html) = 0 then
    raise exception 'That page has no built HTML to publish.';
  end if;
  v_hash := encode(sha256(convert_to(p_current_html, 'UTF8')), 'hex');
  if v_hash <> v_snapshot.rendered_sha256 then
    raise exception 'This page changed after it was approved. Request approval of the new version.';
  end if;
end $$;

comment on function public.assert_page_publish_by_approval_v6(uuid, uuid, text) is
  'Permits exactly one publish: this page, under this approval, at the revision and byte hash a person read. 212''s general block is untouched, so every other route into publication stays closed.';

revoke all on function public.assert_page_publish_by_approval_v6(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.assert_page_publish_by_approval_v6(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- What was published, and where
-- ---------------------------------------------------------------------------

create table public.campaign_page_publications (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null unique references public.campaign_action_approvals(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  page_id uuid not null references public.client_pages(id) on delete cascade,
  revision_id uuid not null references public.client_page_revisions(id) on delete restrict,

  published_url text not null check (published_url ~ '^https?://'),
  commit_sha text not null check (length(btrim(commit_sha)) between 7 and 64),
  rendered_sha256 text not null check (rendered_sha256 ~ '^[0-9a-f]{64}$'),

  -- Whether a test submission reached Sales OS as a sourced, consented lead.
  -- Null means nobody has looked, which is not the same as working.
  probe_status text check (probe_status is null or probe_status in ('passed', 'failed')),
  probe_detail text,
  probe_lead_id uuid references public.client_leads(id) on delete set null,
  probed_at timestamptz,

  published_at timestamptz not null default now()
);

comment on table public.campaign_page_publications is
  'One commit of one approved page. The probe columns are deliberately nullable: a page nobody has tested is not a page known to work, and the difference has to be visible.';

create index campaign_page_publications_client_idx
  on public.campaign_page_publications (client_id, published_at desc);

alter table public.campaign_page_publications enable row level security;
create policy campaign_page_publications_read on public.campaign_page_publications
  for select to authenticated using (
    public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
grant select on public.campaign_page_publications to authenticated;
grant all on public.campaign_page_publications to service_role;

create function public.record_campaign_page_published_v6(
  p_approval_id uuid, p_published_url text, p_commit_sha text, p_rendered_sha256 text)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_snapshot public.campaign_page_approval_snapshots%rowtype;
  v_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record a publication.';
  end if;
  select * into v_snapshot from public.campaign_page_approval_snapshots
   where approval_id = p_approval_id;
  if not found then raise exception 'That approval has no snapshot.'; end if;

  insert into public.campaign_page_publications (
    approval_id, client_id, page_id, revision_id, published_url, commit_sha, rendered_sha256)
  values (
    p_approval_id, v_snapshot.client_id, v_snapshot.page_id, v_snapshot.revision_id,
    p_published_url, btrim(p_commit_sha), p_rendered_sha256)
  on conflict (approval_id) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.campaign_page_publications where approval_id = p_approval_id;
  end if;
  return v_id;
end $$;

revoke all on function public.record_campaign_page_published_v6(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_campaign_page_published_v6(uuid, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- The probe
-- ---------------------------------------------------------------------------

-- What "live" has to mean. A page is published when a commit exists; it is
-- working when a submission made against it arrives in Sales OS with its
-- campaign, its source and its consent. Those are different facts and this
-- records the second one separately, including when it fails.
create function public.record_campaign_page_probe_v6(
  p_publication_id uuid, p_passed boolean, p_detail text, p_lead_id uuid default null)
returns void language plpgsql security definer
set search_path = pg_catalog, public as $$
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may record a probe.';
  end if;
  update public.campaign_page_publications
     set probe_status = case when coalesce(p_passed, false) then 'passed' else 'failed' end,
         probe_detail = p_detail,
         probe_lead_id = p_lead_id,
         probed_at = now()
   where id = p_publication_id;
  if not found then raise exception 'No such publication.'; end if;
end $$;

revoke all on function public.record_campaign_page_probe_v6(uuid, boolean, text, uuid)
  from public, anon, authenticated;
grant execute on function public.record_campaign_page_probe_v6(uuid, boolean, text, uuid) to service_role;

-- A probe lead is a real row in `client_leads` — it has to be, or the probe
-- would be testing something other than what a customer meets. So it is
-- marked, and the pipeline can exclude it rather than a person wondering who
-- "AA Console Probe" is.
alter table public.client_leads
  add column if not exists is_probe boolean not null default false;

comment on column public.client_leads.is_probe is
  'A lead created by a post-publish form probe. Real in every other respect, because a probe that wrote somewhere else would be testing the wrong path.';

create index if not exists client_leads_real_idx
  on public.client_leads (client_id, created_at desc) where not is_probe;

-- ---------------------------------------------------------------------------
-- Why a page has not gone live
-- ---------------------------------------------------------------------------

create or replace view campaign_page_publish_due with (security_invoker = true) as
select
  a.id as approval_id,
  a.client_id,
  a.campaign_id,
  s.page_id,
  s.site_path,
  s.rendered_sha256,
  p.id as publication_id,
  p.published_url,
  p.commit_sha,
  p.probe_status,
  p.probe_detail,
  case
    when a.status <> 'approved' then 'This page deployment is ' || a.status || '.'
    when exists (select 1 from public.campaign_manifest_versions v
                  where v.campaign_id = a.campaign_id and v.version > m.version)
      then 'The campaign package was superseded after this was approved. Request approval again.'
    when pg.html is null or length(btrim(pg.html)) = 0
      then 'The page has no built HTML.'
    when encode(sha256(convert_to(pg.html, 'UTF8')), 'hex') <> s.rendered_sha256
      then 'The page changed after it was approved. Request approval of the new version.'
    when not coalesce(ces.campaign_actions_enabled, false)
      then 'External campaign actions are off for this client.'
    when p.id is not null and p.probe_status = 'failed'
      then 'Published, but the form probe failed: ' || coalesce(p.probe_detail, 'no detail recorded') || '.'
    when p.id is not null and p.probe_status is null
      then 'Published. Nobody has tested the form yet.'
    when p.id is not null then 'Live and tested.'
    else null
  end as blocker
from public.campaign_action_approvals a
join public.campaign_page_approval_snapshots s on s.approval_id = a.id
join public.campaign_manifest_versions m on m.id = a.manifest_id
join public.client_pages pg on pg.id = s.page_id
left join public.campaign_page_publications p on p.approval_id = a.id
left join public.client_engine_settings ces on ces.client_id = a.client_id
where a.action_key = 'page_deploy';

comment on view campaign_page_publish_due is
  'Every page deployment decision and what became of it. "Published. Nobody has tested the form yet." is deliberately not the same sentence as "Live and tested."';

grant select on campaign_page_publish_due to authenticated;

select lock_down_definer_functions();

-- v6.1 / Phase 4: the page_deploy executor attests the artefact, not the source.
--
-- The coverage ledger has carried one line against page_deploy since migration
-- 274: "Full HTML is frozen, but the deploy executor has not attested the same
-- version." Source and decision are both verified. This is the last of the
-- three, and of thirty-four classes it is the only one whose executor was
-- within reach without a connected provider account.
--
-- WHAT WAS ACTUALLY MISSING
--
-- 237 did most of this already, and did it well.
-- assert_page_publish_by_approval_v6 refuses unless the approval is a
-- page_deploy, is approved, has a snapshot for this page, is not superseded by
-- a later campaign package, and -- the point -- unless sha256 of the page's
-- current HTML still equals the hash a person read. 212's general gate refuses
-- a v6 campaign page outright, so that is the only way in.
--
-- The gap is one step further on. The runtime publishes
-- htmlToPublish(page.html), which INJECTS the sales agent widget when the page
-- has a deployment. So for any page carrying a sales agent, the bytes committed
-- to the repository are not the bytes that were approved -- and the executor
-- recorded sha256(page.html) regardless. The publication row therefore claimed
-- a hash that was not what went live, and record_campaign_page_published_v6
-- took that hash on trust without once comparing it to the snapshot it had
-- already loaded.
--
-- "Attested the same version" has to mean the artefact. A record of the source
-- is a record of what the executor READ, not of what it PUT on the internet,
-- and the difference is exactly where an unreviewed script would hide.
--
-- WHAT THIS CHANGES
--
-- One column and one check.
--
--   published_sha256  the bytes actually committed, which for a page with no
--                     sales agent equals rendered_sha256 and for a page with
--                     one does not.
--
-- and record_campaign_page_published_v6 now verifies rendered_sha256 against
-- the snapshot rather than believing the caller. A caller that cannot say what
-- it published, or that reports a source hash which does not match what was
-- approved, no longer gets a publication row.
--
-- WHY THE INJECTION IS NOT SIMPLY BANNED
--
-- It is the only script allowed onto a published page, it is AA's own, it is
-- added at publish time precisely so the generated HTML can stay script-free
-- (htmlSafetyProblem refuses a <script> on every path that writes
-- client_pages.html), and it is served from the runtime so one fix reaches
-- every site. Banning it would push the widget back into the stored HTML,
-- which is the thing the no-script rule exists to prevent. So it stays, and
-- the attestation grows to cover it.

alter table public.campaign_page_publications
  add column published_sha256 text
    check (published_sha256 is null or published_sha256 ~ '^[0-9a-f]{64}$');

comment on column public.campaign_page_publications.rendered_sha256 is
  'Hash of the approved source HTML, verified against the approval snapshot when the row is written.';
comment on column public.campaign_page_publications.published_sha256 is
  'Hash of the bytes actually committed to the repository. Differs from rendered_sha256 when the sales agent widget was injected at publish time, which is the only script a published page may carry. Null only on rows written before migration 313.';

-- The old signature must GO, not be replaced alongside. Adding a defaulted
-- parameter makes a new overload: the four-argument function would still exist
-- and still be callable, and it is the one with none of the checks below. A
-- caller that kept passing four arguments would quietly keep the old
-- behaviour, which is worse than leaving this migration unwritten.
drop function if exists public.record_campaign_page_published_v6(uuid, text, text, text);

create or replace function public.record_campaign_page_published_v6(
  p_approval_id uuid,
  p_published_url text,
  p_commit_sha text,
  p_rendered_sha256 text,
  p_published_sha256 text default null
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public
as $$
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

  -- 237 took this hash on trust. It is the executor's own claim about what it
  -- read, and the snapshot is right here, so there is no reason to believe it
  -- rather than check it.
  if p_rendered_sha256 is distinct from v_snapshot.rendered_sha256 then
    raise exception 'That is not the approved version of this page.';
  end if;

  -- What actually went live. Required, because a publication record that
  -- cannot say what it published is the gap this migration exists to close.
  if p_published_sha256 is null or p_published_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A publication must record the hash of the bytes it committed.';
  end if;

  insert into public.campaign_page_publications (
    approval_id, client_id, page_id, revision_id, published_url, commit_sha,
    rendered_sha256, published_sha256)
  values (
    p_approval_id, v_snapshot.client_id, v_snapshot.page_id, v_snapshot.revision_id,
    p_published_url, btrim(p_commit_sha), p_rendered_sha256, p_published_sha256)
  on conflict (approval_id) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.campaign_page_publications where approval_id = p_approval_id;
  end if;
  return v_id;
end $$;

comment on function public.record_campaign_page_published_v6(uuid, text, text, text, text) is
  'Records one publication against its approval, verifying the approved source hash against the snapshot and requiring the hash of the bytes actually committed. The two differ whenever the sales agent widget was injected at publish time.';

revoke all on function public.record_campaign_page_published_v6(uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_campaign_page_published_v6(uuid, text, text, text, text)
  to service_role;

-- The ledger entry this exists to earn. Executor evidence names the migration
-- and the function, the same shape as the source and decision rows.
insert into public.approval_class_coverage_versions_v6 (
  class_id, revision, class_key, title, source_state, source_evidence,
  decision_state, decision_evidence, executor_state, executor_evidence, blocker
)
select class_id, 2, 'page_deploy', title,
  source_state, source_evidence,
  decision_state, decision_evidence,
  'verified',
  '313 record_campaign_page_published_v6 attests the committed artefact; 237 assert_page_publish_by_approval_v6 gates the write',
  null
from public.approval_class_coverage_versions_v6
where class_key = 'page_deploy' and revision = 1;

select lock_down_definer_functions();

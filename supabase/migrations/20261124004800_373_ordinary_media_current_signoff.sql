-- A historical human_approved_at value is not current creative authority.
-- This predicate checks the exact Inbox event and the live source snapshot.
begin;
create function public.ordinary_media_signoff_current_v6(p_asset_id uuid)
returns boolean language plpgsql stable security definer
set search_path = pg_catalog, public, storage set timezone='UTC' as $$
declare a public.client_media_assets%rowtype;
  s public.ordinary_media_signoffs_v6%rowtype;
  q public.ordinary_media_review_requests_v6%rowtype;
  r public.approval_requests_v6%rowtype;
  d public.approval_decision_events_v6%rowtype;
  h text;
begin
  if auth.role() not in ('authenticated','service_role') then return false; end if;
  select * into a from public.client_media_assets where id=p_asset_id;
  if a.id is null or (auth.role()='authenticated'
    and not public.can_access_client(a.client_id)) then return false; end if;
  if a.media_type not in ('image','text') or a.content_format <> 'single'
    or a.render_path is not null or a.edit_stage <> 'review_ready'
    or a.archived_at is not null or a.review_status <> 'approved'
    or a.human_approved_at is null or a.delivery_bytes_sha256 is null
    or a.usage_rights is null then return false; end if;
  select * into s from public.ordinary_media_signoffs_v6
    where asset_id=a.id and client_id=a.client_id;
  if s.asset_id is null then return false; end if;
  select * into q from public.ordinary_media_review_requests_v6
    where canonical_request_id=s.approved_request_id
      and asset_id=a.id and client_id=a.client_id;
  if q.id is null then return false; end if;
  h := public.ordinary_media_review_hash_v6(q);
  select * into r from public.approval_requests_v6
    where id=s.approved_request_id and client_id=a.client_id
      and source_system='aa_console' and source_kind='ordinary_media'
      and source_id=q.id::text;
  if r.id is null or h is null or q.source_hash is distinct from h
    or s.approved_hash is distinct from h or r.artifact_hash is distinct from h
    or r.source_version is distinct from h||':'||q.request_token::text
    or r.preview is distinct from public.ordinary_media_review_preview_v6(q)
    or r.scope is distinct from public.ordinary_media_review_scope_v6(q)
    or r.destination is distinct from 'creative_source:'||a.id::text
    or exists(select 1 from public.delivery_approval_invalidations_v6 i
      where i.approval_request_id=r.id)
    then return false; end if;
  select * into d from public.approval_decision_events_v6
    where request_id=r.id order by event_order desc limit 1;
  return d.decision='approved' and d.actor_aal='aal2'
    and d.actor_id=s.approved_by and d.artifact_hash=h
    and d.source_decision_ref='ordinary_media:'||q.id::text||':'||q.request_token::text;
end $$;
revoke all on function public.ordinary_media_signoff_current_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.ordinary_media_signoff_current_v6(uuid)
  to authenticated,service_role;
select public.lock_down_definer_functions();
commit;

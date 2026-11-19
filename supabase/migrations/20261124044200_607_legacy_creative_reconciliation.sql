-- Legacy human timestamps cannot authorize distribution. Preserve their
-- unverified origin, clear source authority, and require an exact AAL2 review.
begin;
alter table public.ordinary_media_reopen_events_v8
  alter column prior_request_id drop not null;
alter table public.ordinary_media_reopen_events_v8
  add column legacy_approved_at timestamptz;
alter table public.ordinary_media_reopen_events_v8
  add constraint ordinary_media_reopen_origin_v8
  check (num_nonnulls(prior_request_id,legacy_approved_at)=1);
create or replace function public.request_ordinary_media_review_v6(p_asset_id uuid)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare a public.client_media_assets%rowtype;
  q public.ordinary_media_review_requests_v6%rowtype;
  s public.ordinary_media_signoffs_v6%rowtype;
  h text;
begin
  if auth.role()<>'authenticated' or auth.uid() is null
    or public.current_role_of() is null then
    raise exception 'A provisioned human must request creative review.' using errcode='42501';
  end if;
  select * into a from public.client_media_assets where id=p_asset_id for update;
  if a.id is null or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid()=public.active_video_approval_manager(a.client_id),false)
    or coalesce(public.is_client_user(a.client_id),false)) then
    raise exception 'The asset or decision owner is unavailable.' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ordinary_media_review:'||a.id::text,0));
  if a.media_type not in ('image','text') or a.content_format not in ('single','carousel','story')
    or (a.content_format<>'single' and a.render_path is not null)
    or a.edit_stage<>'review_ready'
    or a.archived_at is not null or a.delivery_bytes_sha256 is null
    or a.usage_rights is null
    or (a.content_format<>'single' and not public.framed_creative_evidence_current_v8(a.id)) or a.review_status not in ('pending','approved')
    or exists(select 1 from public.content_slots cs
      where cs.asset_id=a.id and cs.stage='awaiting_approval') then
    raise exception 'This asset needs current bytes, rights and its owning review route.'
      using errcode='23514';
  end if;
  if a.human_approved_at is not null then
    if public.ordinary_media_signoff_current_v6(a.id) then
      raise exception 'This exact creative is already approved.' using errcode='23514';
    end if;
    select * into s from public.ordinary_media_signoffs_v6
      where asset_id=a.id and client_id=a.client_id
      order by approved_at desc,id desc limit 1;
    if s.id is null then
      if a.review_status is distinct from 'approved'::public.review_status then
        raise exception 'Legacy creative approval state is inconsistent.' using errcode='23514';
      end if;
      insert into public.ordinary_media_reopen_events_v8
        (asset_id,client_id,legacy_approved_at,reopened_by,reason)
      values(a.id,a.client_id,a.human_approved_at,auth.uid(),
        'Legacy human approval has no exact Inbox signoff; clear its authority and request an exact decision.');
    else
      insert into public.ordinary_media_reopen_events_v8
        (asset_id,client_id,prior_request_id,reopened_by,reason)
      values(a.id,a.client_id,s.approved_request_id,auth.uid(),
        'The prior exact creative signoff is stale; request a new review.');
    end if;
    update public.client_media_assets
      set human_approved_at=null,review_status='pending' where id=a.id;
  end if;
  select * into q from public.ordinary_media_review_requests_v6
    where asset_id=a.id order by created_at desc,id desc limit 1;
  if q.id is not null and q.canonical_request_id is not null
    and q.source_hash=public.ordinary_media_review_hash_v6(q)
    and exists(select 1 from public.approval_requests_v6 r
      where r.id=q.canonical_request_id and r.expires_at>now()
        and r.artifact_hash=q.source_hash)
    and not exists(select 1 from public.approval_decision_events_v6 d
      where d.request_id=q.canonical_request_id)
    then return q.canonical_request_id; end if;
  insert into public.ordinary_media_review_requests_v6(asset_id,client_id,created_at)
    values(a.id,a.client_id,clock_timestamp()) returning * into q;
  h:=public.ordinary_media_review_hash_v6(q);
  if h is null then raise exception 'Creative Storage identity is unavailable.'
    using errcode='23514'; end if;
  update public.ordinary_media_review_requests_v6 set source_hash=h
    where id=q.id returning * into q;
  q.canonical_request_id:=public.register_approval_request_v6(jsonb_build_object(
    'client_id',q.client_id,'source_system','aa_console',
    'source_kind','ordinary_media','source_id',q.id::text,
    'source_version',h||':'||q.request_token::text,
    'title','Review creative: '||coalesce(nullif(a.title,''),a.id::text),
    'artifact_hash',h,'preview',public.ordinary_media_review_preview_v6(q),
    'destination','creative_source:'||a.id::text,
    'scope',public.ordinary_media_review_scope_v6(q),
    'owner_role','admin_or_active_client_manager',
    'requested_by',auth.uid(),'requester_kind','human',
    'expires_at',now()+interval '7 days',
    'owning_path','/clients/'||a.client_id::text||'/delivery/approval-inbox?tab=assets'));
  update public.ordinary_media_review_requests_v6
    set canonical_request_id=q.canonical_request_id where id=q.id;
  return q.canonical_request_id;
end $$;



select public.lock_down_definer_functions();
commit;

-- A provider GET is evidence, not itself a decision. An AAL2 owner resolves
-- an exact, recent LIVE text read; absent, mismatched and media-only reads
-- remain held. If current proof rights are no longer cleared, demand removal.
begin;

insert into public.proof_placement_transitions(from_status,to_status,note)
values ('uncertain','placed','An exact live provider read resolved the unknown POST.'),
       ('uncertain','retraction_required','The post is live but current proof rights are not cleared.')
on conflict (from_status,to_status) do nothing;

create function public.resolve_proof_placement_readback_v8(
  p_placement_id uuid,p_read_id uuid)
returns text language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare p public.proof_placements%rowtype;
  r public.proof_placement_provider_reads_v8%rowtype;
  a public.proof_placement_approvals%rowtype;
  s public.client_proof_assets%rowtype;
  v_account text;
  v_rights_current boolean;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null
    or coalesce(auth.jwt()->>'aal','')<>'aal2' then
    raise exception 'A provisioned AAL2 owner must resolve a provider read.'
      using errcode='42501';
  end if;
  select * into p from public.proof_placements where id=p_placement_id for update;
  if p.id is null or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid()=public.active_video_approval_manager(p.client_id),false)) then
    raise exception 'Only the client approval owner may resolve this read.'
      using errcode='42501';
  end if;
  if p.destination_key<>'google_business_profile'
    or p.status not in ('uncertain','placed') or p.asset_id is not null then
    raise exception 'This placement needs a separate human inspection.'
      using errcode='23514';
  end if;
  select * into r from public.proof_placement_provider_reads_v8
    where id=p_read_id and placement_id=p.id and client_id=p.client_id;
  select account_ref into v_account from public.client_proof_destinations
    where client_id=p.client_id and destination_key=p.destination_key;
  if r.id is null or r.result<>'live_exact_text' or r.provider_state<>'LIVE'
    or r.checked_at<clock_timestamp()-interval '1 hour'
    or r.checked_at>clock_timestamp()+interval '1 minute'
    or r.id is distinct from (select last_read.id
      from public.proof_placement_provider_reads_v8 last_read
      where last_read.placement_id=p.id
      order by last_read.checked_at desc,last_read.id desc limit 1)
    or r.external_id is distinct from p.external_id
    or r.account_ref is distinct from v_account
    or r.payload_hash is distinct from p.payload_hash
    or v_account is null
    or not starts_with(r.external_id,v_account||'/localPosts/')
    or p.payload_hash is distinct from public.proof_placement_payload_hash_v6(
      p.artifact_version_id,p.proof_id,p.asset_id,p.destination_key)
    or exists(select 1 from public.agent_jobs j
      where j.agent_key='proof_placement_reconciler'
        and j.input_table='proof_placements' and j.input_id=p.id
        and j.status in ('queued','claimed','running','paused')) then
    raise exception 'The exact live read is stale, incomplete or superseded.'
      using errcode='23514';
  end if;
  select * into a from public.proof_placement_approvals
    where id=p.approval_id and placement_id=p.id and client_id=p.client_id;
  select * into s from public.client_proof_assets
    where id=p.source_proof_id and client_id=p.client_id;
  v_rights_current := coalesce(a.status='approved'
    and a.destination_key=p.destination_key and a.payload_hash=p.payload_hash
    and (p.proof_id is null or (s.media_type='text' and s.storage_path is null))
    and s.usage_rights='approved'
    and nullif(btrim(s.permission_basis),'') is not null
    and (s.expires_on is null or s.expires_on>=current_date)
    and s.approved_rights_request_id is not null
    and public.proof_rights_source_state_v6(s.approved_rights_request_id)='source_decided'
    and exists(select 1 from public.approval_inbox_v6 i
      where i.id=s.approved_rights_request_id and i.status='approved')
    and (p.artifact_version_id is null
      or public.proof_artifact_signoff_current_v6(p.artifact_version_id))
    and ((a.campaign_action_approval_id is not null and exists(
      select 1 from public.approval_requests_v6 ar
      join lateral (select d.decision,d.actor_aal
        from public.approval_decision_events_v6 d where d.request_id=ar.id
        order by d.event_order desc limit 1) d on true
      where ar.source_system='aa_console' and ar.source_kind='campaign_action'
        and ar.source_id=a.campaign_action_approval_id::text
        and ar.client_id=p.client_id
        and d.decision='approved' and d.actor_aal='aal2'))
      or (a.canonical_request_id is not null and exists(
      select 1 from public.approval_requests_v6 ar
      join lateral (select d.decision,d.actor_aal
        from public.approval_decision_events_v6 d where d.request_id=ar.id
        order by d.event_order desc limit 1) d on true
      where ar.id=a.canonical_request_id and ar.client_id=p.client_id
        and ar.source_system='aa_console' and ar.source_kind='proof_placement'
        and ar.source_id=a.id::text
        and d.decision='approved' and d.actor_aal='aal2'))),false);

  if p.status='uncertain' then
    if v_rights_current then
      update public.proof_placements set status='placed',
        placed_at=coalesce(placed_at,r.checked_at),
        external_url=coalesce(external_url,r.provider_url),last_error=null
        where id=p.id;
      insert into public.proof_placement_events
        (placement_id,client_id,event,actor,detail,external_ref)
      values (p.id,p.client_id,'placed','human',
        'Provider presence confirmed by exact LIVE text read '||r.id::text,
        r.external_id);
    else
      update public.proof_placements set status='retraction_required',
        external_url=coalesce(external_url,r.provider_url),
        last_error='Exact LIVE provider read found proof whose current rights or approval need review.'
        where id=p.id;
      insert into public.proof_placement_events
        (placement_id,client_id,event,actor,detail,external_ref)
      values (p.id,p.client_id,'retraction_required','human',
        'Provider presence confirmed by read '||r.id::text||'; current rights or approval are not cleared.',
        r.external_id);
      return 'retraction_required';
    end if;
  end if;
  if not v_rights_current then
    update public.proof_placements set status='retraction_required',
      last_error='Exact LIVE provider read found proof whose current rights or approval need review.'
      where id=p.id;
    insert into public.proof_placement_events
      (placement_id,client_id,event,actor,detail,external_ref)
    values (p.id,p.client_id,'retraction_required','human',
      'Provider presence confirmed by read '||r.id::text||'; current rights or approval are not cleared.',
      r.external_id);
    return 'retraction_required';
  end if;
  update public.proof_placements set status='verified',verified_at=now(),
    external_url=coalesce(external_url,r.provider_url) where id=p.id;
  insert into public.proof_placement_events
    (placement_id,client_id,event,actor,detail,external_ref)
  values (p.id,p.client_id,'verified','human',
    'Exact LIVE text read '||r.id::text||' reviewed; media not involved.',r.external_id);
  return 'verified';
end $$;
revoke all on function public.resolve_proof_placement_readback_v8(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.resolve_proof_placement_readback_v8(uuid,uuid)
  to authenticated;
select public.lock_down_definer_functions();
commit;

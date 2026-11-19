-- Rollback-only exact text proof readback resolution. No provider call.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a4444444-4444-4444-8444-444444444444',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'proof-readback-admin@example.invalid','',now(),now()),
  ('c4444444-4444-4444-8444-444444444444',
  '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
  'proof-readback-outsider@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('a4444444-4444-4444-8444-444444444444','admin','proof-readback-admin@example.invalid'),
  ('c4444444-4444-4444-8444-444444444444','client','proof-readback-outsider@example.invalid');
insert into public.clients(id,name,initials) values
  ('b4444444-4444-4444-8444-444444444444','Proof readback fixture','RB');
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','a4444444-4444-4444-8444-444444444444',true);
select set_config('request.jwt.claims',
  '{"sub":"a4444444-4444-4444-8444-444444444444","role":"authenticated","aal":"aal1"}',true);

do $checks$
declare c uuid:='b4444444-4444-4444-8444-444444444444';
  p public.client_proof_assets%rowtype;
  rights_req uuid; rights_id uuid; pl uuid; pl2 uuid;
  req uuid; approval uuid; job uuid; read_id uuid; old_read uuid; missing_read uuid; new_read uuid;
  ext text:='accounts/123/locations/456/localPosts/7';
  refused boolean; result text;
begin
  insert into public.client_proof_assets(client_id,media_type,title,body,source,claim,evidence)
    values(c,'text','Customer result','Signed result','Interview',
      'Arrived on time','Signed handover') returning * into p;
  rights_req:=public.request_proof_rights_v6(p.id,'Customer signed the release');
  select id into rights_id from public.proof_rights_requests_v6
    where canonical_request_id=rights_req;
  perform set_config('request.jwt.claims',
    '{"sub":"a4444444-4444-4444-8444-444444444444","role":"authenticated","aal":"aal2"}',true);
  perform public.approve_proof_rights_v6(rights_id,rights_req);
  insert into public.client_proof_destinations
    (client_id,destination_key,enabled,account_ref)
    values(c,'google_business_profile',true,'accounts/123/locations/456');

  pl:=public.create_proof_placement_v6('readback-a',c,'google_business_profile',
    p_proof_id=>p.id);
  req:=public.request_proof_placement_inbox_v6(pl);
  select approval_id into approval from public.proof_placements where id=pl;
  perform public.decide_proof_placement_inbox_v6(approval,req,true);
  if (select status from public.proof_placements where id=pl)<>'queued' then
    raise exception 'Approved API placement did not queue'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  update public.proof_placements set status='placing' where id=pl;
  perform public.record_proof_placement_uncertain_v8(pl,'POST acknowledgement lost',ext);
  insert into public.agent_jobs(agent_key,client_id,input_table,input_id,status)
    values('proof_placement_reconciler',c,'proof_placements',pl,'completed')
    returning id into job;
  insert into public.proof_placement_provider_reads_v8
    (placement_id,client_id,job_id,external_id,account_ref,payload_hash,
      result,provider_state,observed_summary_sha256)
    select pl,c,job,ext,'accounts/123/locations/456',payload_hash,
      'live_exact_text','LIVE',repeat('a',64)
    from public.proof_placements where id=pl returning id into read_id;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','a4444444-4444-4444-8444-444444444444',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a4444444-4444-4444-8444-444444444444","role":"authenticated","aal":"aal1"}',true);
  refused:=false;
  begin perform public.resolve_proof_placement_readback_v8(pl,read_id);
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'AAL1 resolved a provider read'; end if;
  perform set_config('request.jwt.claim.sub','c4444444-4444-4444-8444-444444444444',true);
  perform set_config('request.jwt.claims',
    '{"sub":"c4444444-4444-4444-8444-444444444444","role":"authenticated","aal":"aal2"}',true);
  refused:=false;
  begin perform public.resolve_proof_placement_readback_v8(pl,read_id);
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'Wrong-client user resolved a provider read'; end if;
  perform set_config('request.jwt.claim.sub','a4444444-4444-4444-8444-444444444444',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a4444444-4444-4444-8444-444444444444","role":"authenticated","aal":"aal2"}',true);
  result:=public.resolve_proof_placement_readback_v8(pl,read_id);
  if result<>'verified' or (select status from public.proof_placements where id=pl)<>'verified'
    or (select count(*) from public.proof_placement_events
      where placement_id=pl and event in ('placed','verified'))<>2 then
    raise exception 'Exact live read failed: result %, state %, events %, approval %, rights %, detail %',
      result,(select status from public.proof_placements where id=pl),
      (select count(*) from public.proof_placement_events where placement_id=pl
        and event in ('placed','verified')),
      (select status from public.proof_placement_approvals where id=approval),
      public.proof_rights_source_state_v6(rights_req),
      (select jsonb_build_object('proof_media',sp.media_type,'path',sp.storage_path,
        'usage',sp.usage_rights,'basis',sp.permission_basis,
        'rights_request',sp.approved_rights_request_id,
        'placement_request',a.canonical_request_id,
        'placement_inbox',i.status,'decision',d.decision,'aal',d.actor_aal,
        'hash_match',a.payload_hash=(select payload_hash from public.proof_placements where id=pl))
        from public.proof_placement_approvals a
        cross join public.client_proof_assets sp
        left join public.approval_inbox_v6 i on i.id=a.canonical_request_id
        left join lateral (select decision,actor_aal from public.approval_decision_events_v6
          where request_id=i.id order by event_order desc limit 1) d on true
        where a.id=approval and sp.id=p.id); end if;

  pl2:=public.create_proof_placement_v6('readback-b',c,'google_business_profile',
    p_proof_id=>p.id);
  req:=public.request_proof_placement_inbox_v6(pl2);
  select approval_id into approval from public.proof_placements where id=pl2;
  perform public.decide_proof_placement_inbox_v6(approval,req,true);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  update public.proof_placements set status='placing' where id=pl2;
  perform public.record_proof_placement_uncertain_v8(pl2,'POST acknowledgement lost',
    'accounts/123/locations/456/localPosts/8');
  insert into public.agent_jobs(agent_key,client_id,input_table,input_id,status)
    values('proof_placement_reconciler',c,'proof_placements',pl2,'completed')
    returning id into job;
  insert into public.proof_placement_provider_reads_v8
    (placement_id,client_id,job_id,external_id,account_ref,payload_hash,
      result,provider_state,observed_summary_sha256,checked_at)
    select pl2,c,job,'accounts/123/locations/456/localPosts/8',
      'accounts/123/locations/456',payload_hash,'live_exact_text','LIVE',
      repeat('a',64),now()-interval '2 hours'
    from public.proof_placements where id=pl2 returning id into old_read;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','a4444444-4444-4444-8444-444444444444',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a4444444-4444-4444-8444-444444444444","role":"authenticated","aal":"aal2"}',true);
  refused:=false;
  begin perform public.resolve_proof_placement_readback_v8(pl2,old_read);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Stale read resolved an uncertain placement'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.agent_jobs(agent_key,client_id,input_table,input_id,status)
    values('proof_placement_reconciler',c,'proof_placements',pl2,'completed')
    returning id into job;
  insert into public.proof_placement_provider_reads_v8
    (placement_id,client_id,job_id,external_id,account_ref,payload_hash,result)
    select pl2,c,job,'accounts/123/locations/456/localPosts/8',
      'accounts/123/locations/456',payload_hash,'not_found'
    from public.proof_placements where id=pl2 returning id into missing_read;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','a4444444-4444-4444-8444-444444444444',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a4444444-4444-4444-8444-444444444444","role":"authenticated","aal":"aal2"}',true);
  refused:=false;
  begin perform public.resolve_proof_placement_readback_v8(pl2,missing_read);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'A 404 read resolved an uncertain placement'; end if;
  update public.client_proof_assets set usage_rights='restricted' where id=p.id;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.agent_jobs(agent_key,client_id,input_table,input_id,status)
    values('proof_placement_reconciler',c,'proof_placements',pl2,'completed')
    returning id into job;
  insert into public.proof_placement_provider_reads_v8
    (placement_id,client_id,job_id,external_id,account_ref,payload_hash,
      result,provider_state,observed_summary_sha256)
    select pl2,c,job,'accounts/123/locations/456/localPosts/8',
      'accounts/123/locations/456',payload_hash,'live_exact_text','LIVE',repeat('a',64)
    from public.proof_placements where id=pl2 returning id into new_read;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','a4444444-4444-4444-8444-444444444444',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a4444444-4444-4444-8444-444444444444","role":"authenticated","aal":"aal2"}',true);
  refused:=false;
  begin perform public.resolve_proof_placement_readback_v8(pl2,old_read);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Superseded read resolved an uncertain placement'; end if;
  result:=public.resolve_proof_placement_readback_v8(pl2,new_read);
  if result<>'retraction_required'
    or (select status from public.proof_placements where id=pl2)<>'retraction_required'
    or not exists(select 1 from public.proof_placement_events
      where placement_id=pl2 and event='retraction_required') then
    raise exception 'Live proof with revoked rights did not require removal'; end if;
end $checks$;
rollback;

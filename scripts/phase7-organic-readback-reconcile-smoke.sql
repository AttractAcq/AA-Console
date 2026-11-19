-- Disposable view/scheduler contract. Synthetic seed bypasses production
-- creation guards only inside this rollback transaction; all reads and the
-- enqueue call run with triggers back on. No provider request is made.
begin;
do $schedule$
begin
  if not exists(select 1 from cron.job
      where jobname='organic-provider-readback-reconcile'
        and schedule='*/15 * * * *' and active=false) then
    raise exception 'Read-only retry schedule was not installed inactive';
  end if;
end $schedule$;
set local session_replication_role='replica';
do $seed$
declare c uuid; p uuid; s uuid;
begin
  insert into public.clients(name,initials) values('Readback retry fixture','RR')
    returning id into c;
  insert into public.client_integrations
    (client_id,provider,credential_label,meta_page_id,credential_secret_id,status)
    values (c,'meta','fixture','123',gen_random_uuid(),'active');
  insert into public.scheduled_posts
    (client_id,scheduled_for,scheduled_at,channel,media_type,platform,
      publication_status,published_at,external_id)
    values (c,current_date-1,now()-interval '1 day','organic','image','facebook',
      'published',now()-interval '20 minutes','123_456') returning id into p;
  insert into public.content_slots(client_id,platform,scheduled_at)
    values (c,'facebook',now()-interval '1 day') returning id into s;
  insert into public.organic_publication_packages_v6
    (client_id,scheduled_post_id,slot_id,source_snapshot_hash,artifact_hash,manifest)
    values (c,p,s,repeat('a',64),repeat('b',64),
      jsonb_build_object('platform','facebook','account_ref','123'));
  perform set_config('aa.readback_fixture_post',p::text,true);
end $seed$;
set local session_replication_role='origin';

do $checks$
declare p uuid:=current_setting('aa.readback_fixture_post')::uuid;
  n integer; queued uuid;
begin
  select count(*) into n from public.organic_provider_readback_retry_due_v8
    where post_id=p;
  if n<>1 then raise exception 'Missing acknowledged ID was not due: %',n; end if;
  insert into public.organic_provider_readback_events_v8
    (post_id,client_id,frame_position,platform,external_id,
      expected_account_ref,state,checked_at)
    select p,client_id,0,'facebook','123_456','123','unavailable',
      now()-interval '20 minutes' from public.scheduled_posts where id=p;
  select count(*) into n from public.organic_provider_readback_retry_due_v8
    where post_id=p;
  if n<>1 then raise exception 'Old unavailable read was not due: %',n; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  queued:=public.enqueue_organic_readback_reconciliation_v8();
  if queued is null or public.enqueue_organic_readback_reconciliation_v8() is not null then
    raise exception 'Read-only sweep was not deduplicated'; end if;
  insert into public.organic_provider_readback_events_v8
    (post_id,client_id,frame_position,platform,external_id,
      expected_account_ref,observed_account_ref,state)
    select p,client_id,0,'facebook','123_456','123','123','verified'
    from public.scheduled_posts where id=p;
  select count(*) into n from public.organic_provider_readback_retry_due_v8
    where post_id=p;
  if n<>0 then raise exception 'Verified ID remained due'; end if;
end $checks$;
rollback;

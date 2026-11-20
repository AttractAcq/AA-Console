-- An ambiguous public write and an abandoned claim must never be retried
-- automatically. All rows are rolled back after the assertions.
begin;
select set_config('request.jwt.claim.role','service_role',true);
do $checks$
declare c public.clients%rowtype; p public.scheduled_posts%rowtype;
  stale public.scheduled_posts%rowtype; refused boolean:=false; reaped integer;
begin
  insert into public.clients(name,initials)
    values('Organic uncertain fixture','OU') returning * into c;
  insert into public.scheduled_posts
    (client_id,scheduled_for,scheduled_at,channel,media_type,platform)
    values(c.id,current_date,now(),'organic','image','instagram')
    returning * into p;
  update public.scheduled_posts set publication_status='publishing',
    publish_attempts=1,publish_claimed_at=now() where id=p.id;
  perform public.record_post_publish_uncertain_v7(p.id,
    'Public write response timed out; inspect the account.');
  select * into p from public.scheduled_posts where id=p.id;
  if p.publication_status<>'uncertain' or p.publish_claimed_at is not null
     or p.publish_attempts<>1 then
    raise exception 'Ambiguous post was not held with its attempt';
  end if;
  if not exists(select 1 from public.post_publication_events_v6
      where post_id=p.id and event='uncertain' and attempt_number=1) then
    raise exception 'Uncertain event not recorded';
  end if;
  begin
    perform public.record_post_publish_failure(p.id,'retry',true,3);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Failure handler requeued an uncertain post'; end if;
  if (select publication_status from public.scheduled_posts where id=p.id)<>'uncertain' then
    raise exception 'Uncertain post state changed after refusal';
  end if;

  insert into public.scheduled_posts
    (client_id,scheduled_for,scheduled_at,channel,media_type,platform)
    values(c.id,current_date,now(),'organic','image','facebook')
    returning * into stale;
  update public.scheduled_posts set publication_status='publishing',
    publish_attempts=1,publish_claimed_at=now()-interval '20 minutes'
    where id=stale.id;
  select public.reap_stale_publish_claims(interval '15 minutes') into reaped;
  if reaped<>1 or (select publication_status from public.scheduled_posts
      where id=stale.id)<>'uncertain' then
    raise exception 'Stale claim was not held for inspection: %',reaped;
  end if;
  if not exists(select 1 from public.post_publication_events_v6
      where post_id=stale.id and event='uncertain') then
    raise exception 'Stale claim uncertain event missing';
  end if;
end $checks$;
rollback;

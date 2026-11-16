-- A retry keeps its earlier attempt and failure, and removing a calendar row
-- does not erase the observed publication history. This is a disposable run.
begin;
do $checks$
declare c public.clients%rowtype; p public.scheduled_posts%rowtype;
  trail text[]; refused boolean:=false;
begin
  insert into public.clients(name,initials) values('Organic history fixture','OH') returning * into c;
  insert into public.scheduled_posts
    (client_id,scheduled_for,scheduled_at,channel,media_type,platform)
    values(c.id,current_date,now(),'organic','image','instagram') returning * into p;
  update public.scheduled_posts set publication_status='publishing',
    publish_attempts=1,publish_claimed_at=now() where id=p.id;
  update public.scheduled_posts set publication_status='scheduled',
    failure_reason='Rate limited',publish_claimed_at=null where id=p.id;
  update public.scheduled_posts set publication_status='publishing',
    publish_attempts=2,publish_claimed_at=now() where id=p.id;
  update public.scheduled_posts set publication_status='published',
    published_at=now(),external_id='ig_fixture_1',
    external_url='https://instagram.example/p/fixture',publish_claimed_at=null
    where id=p.id;
  delete from public.scheduled_posts where id=p.id;
  select array_agg(event order by occurred_at,id) into trail
    from public.post_publication_events_v6 where post_id=p.id;
  if trail is distinct from array['scheduled','attempted','retry_queued',
    'attempted','published','removed_from_calendar']::text[] then
    raise exception 'Publication event sequence missing: %',trail;
  end if;
  if not exists(select 1 from public.post_publication_events_v6
      where post_id=p.id and event='published' and attempt_number=2
        and external_id='ig_fixture_1') then
    raise exception 'Provider identifier or retry attempt was lost';
  end if;
  begin
    delete from public.post_publication_events_v6 where post_id=p.id;
  exception when others then refused:=true; end;
  if not refused then raise exception 'Publication history is not append-only'; end if;
end $checks$;
rollback;

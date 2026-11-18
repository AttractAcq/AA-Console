begin;
do $checks$
declare
  cid uuid;
  measured uuid;
  missing uuid;
  first_post uuid;
begin
  insert into public.clients(name,initials) values('Archive metric coverage fixture','AM')
    returning id into cid;
  insert into public.client_media_assets(client_id,title,media_type,storage_path)
    values(cid,'Measured asset','image','fixture/measured.png') returning id into measured;
  insert into public.client_media_assets(client_id,title,media_type,storage_path)
    values(cid,'Unmeasured asset','image','fixture/missing.png') returning id into missing;
  insert into public.scheduled_posts(client_id,asset_id,scheduled_for,scheduled_at,channel,media_type,platform)
    values(cid,measured,current_date,now(),'organic','image','instagram') returning id into first_post;
  insert into public.scheduled_posts(client_id,asset_id,scheduled_for,scheduled_at,channel,media_type,platform)
    values(cid,measured,current_date,now(),'organic','image','facebook');

  if not exists (select 1 from public.content_archive_metric_coverage_v8
      where asset_id=measured and client_id=cid and linked_posts=2 and metric_rows=0
        and impression_rows=0 and last_metric_date is null)
     or not exists (select 1 from public.content_archive_metric_coverage_v8
      where asset_id=missing and client_id=cid and linked_posts=0 and metric_rows=0) then
    raise exception 'Missing metric rows were not distinguishable from observed zero';
  end if;

  insert into public.metrics_daily(client_id,surface,entity_type,external_id,metric_date,
    post_id,impressions,clicks,spend,currency,basis)
    values(cid,'organic','post','fixture-post',current_date,first_post,0,4,12,'ZAR','daily');
  if not exists (select 1 from public.content_archive_metric_coverage_v8
      where asset_id=measured and linked_posts=2 and posts_with_metrics=1
        and metric_rows=1 and impression_rows=1 and reach_rows=0
        and currency_count=1 and currency='ZAR' and cumulative_rows=0) then
    raise exception 'Observed zero or partial post coverage was lost';
  end if;

  insert into public.metrics_daily(client_id,surface,entity_type,external_id,metric_date,
    post_id,impressions,spend,currency,basis)
    values(cid,'organic','post','fixture-post',current_date-1,first_post,9,8,'USD','cumulative');
  if not exists (select 1 from public.content_archive_metric_coverage_v8
      where asset_id=measured and metric_rows=2 and cumulative_rows=1
        and currency_count=2 and posts_with_metrics=1) then
    raise exception 'Cumulative or mixed-currency evidence was hidden';
  end if;
end $checks$;
rollback;

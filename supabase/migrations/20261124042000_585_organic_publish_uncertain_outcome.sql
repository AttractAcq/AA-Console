-- A public API write can succeed while its response times out. Such a post
-- must leave the automatic queue until the provider account is inspected.
begin;

alter table public.scheduled_posts
  drop constraint if exists scheduled_posts_publication_status_check;
alter table public.scheduled_posts
  add constraint scheduled_posts_publication_status_check
  check(publication_status in ('scheduled','publishing','published','failed','uncertain'));

alter table public.post_publication_events_v6
  drop constraint if exists post_publication_events_v6_event_check;
alter table public.post_publication_events_v6
  add constraint post_publication_events_v6_event_check
  check(event in ('legacy_snapshot','scheduled','rescheduled','attempted',
    'retry_queued','failed','uncertain','published','removed_from_calendar'));

create or replace function public.record_post_publication_event_v6()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare v_event text; v_row public.scheduled_posts%rowtype;
begin
  if tg_op='INSERT' then
    v_event:='scheduled'; v_row:=new;
  elsif tg_op='DELETE' then
    v_event:='removed_from_calendar'; v_row:=old;
  else
    v_row:=new;
    if new.publication_status='publishing'
       and old.publication_status is distinct from 'publishing' then
      v_event:='attempted';
    elsif new.publication_status='published'
       and old.publication_status is distinct from 'published' then
      v_event:='published';
    elsif new.publication_status='uncertain'
       and old.publication_status is distinct from 'uncertain' then
      v_event:='uncertain';
    elsif new.publication_status='failed'
       and old.publication_status is distinct from 'failed' then
      v_event:='failed';
    elsif new.publication_status='scheduled'
       and old.publication_status='publishing' and new.publish_attempts>0 then
      v_event:='retry_queued';
    elsif new.scheduled_at is distinct from old.scheduled_at then
      v_event:='rescheduled';
    else
      return new;
    end if;
  end if;
  insert into public.post_publication_events_v6
    (post_id,client_id,asset_id,ref_number,media_type,channel,platform,event,
     publication_status,attempt_number,scheduled_at,external_id,external_url,
     detail,actor_role)
  values(v_row.id,v_row.client_id,v_row.asset_id,v_row.ref_number,
    v_row.media_type::text,v_row.channel::text,v_row.platform::text,v_event,
    v_row.publication_status,v_row.publish_attempts,v_row.scheduled_at,
    v_row.external_id,v_row.external_url,v_row.failure_reason,
    coalesce(auth.role(),'unknown'));
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

create function public.record_post_publish_uncertain_v7(p_post_id uuid,p_reason text)
returns public.scheduled_posts language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare v_post public.scheduled_posts%rowtype;
begin
  if auth.role()<>'service_role' then
    raise exception 'Only the publisher may record an uncertain post.'
      using errcode='42501';
  end if;
  if nullif(btrim(p_reason),'') is null then
    raise exception 'An uncertain post needs an inspection reason.'
      using errcode='23514';
  end if;
  select * into v_post from public.scheduled_posts where id=p_post_id for update;
  if v_post.id is null or v_post.publication_status<>'publishing' then
    raise exception 'Only an in-progress post can become uncertain.'
      using errcode='23514';
  end if;
  update public.scheduled_posts
     set publication_status='uncertain',
         failure_reason=btrim(p_reason),publish_claimed_at=null,updated_at=now()
   where id=p_post_id returning * into v_post;
  return v_post;
end $$;
revoke all on function public.record_post_publish_uncertain_v7(uuid,text)
  from public,anon,authenticated;
grant execute on function public.record_post_publish_uncertain_v7(uuid,text)
  to service_role;

-- The older failure RPC accepted any state other than published. Once a
-- provider result is uncertain, that could silently requeue the public write.
create or replace function public.record_post_publish_failure(
  p_post_id uuid,p_reason text,p_retryable boolean default false,
  p_max_attempts integer default 3)
returns public.scheduled_posts language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare v_post public.scheduled_posts%rowtype; v_slot uuid; v_give_up boolean;
begin
  if auth.role()<>'service_role' then
    raise exception 'Publication failures are recorded by the publisher.' using errcode='42501';
  end if;
  if nullif(btrim(p_reason),'') is null then
    raise exception 'A publication failure needs a reason.' using errcode='23514';
  end if;
  select * into v_post from public.scheduled_posts where id=p_post_id for update;
  if v_post.id is null or v_post.publication_status<>'publishing' then
    raise exception 'Only an in-progress post can record a publication failure.'
      using errcode='23514';
  end if;
  v_give_up:=not p_retryable or v_post.publish_attempts>=p_max_attempts;
  update public.scheduled_posts
     set publication_status=case when v_give_up then 'failed' else 'scheduled' end,
         failure_reason=btrim(p_reason),publish_claimed_at=null,updated_at=now()
   where id=p_post_id returning * into v_post;
  if v_give_up then
    select s.id into v_slot from public.content_slots s
      where s.scheduled_post_id=p_post_id and s.stage='scheduled';
    if v_slot is not null then
      perform public.advance_slot(v_slot,'failed','agent',p_reason,'publisher',
        null,null,null,null,null,null,p_reason);
    end if;
  end if;
  return v_post;
end $$;

create or replace function public.reap_stale_publish_claims(
  p_older_than interval default interval '15 minutes')
returns integer language plpgsql security definer
set search_path=pg_catalog,public as $$
declare v_count integer:=0; v_id uuid;
begin
  if auth.role()<>'service_role' then
    raise exception 'Only the publisher may reap stale claims.' using errcode='42501';
  end if;
  for v_id in select sp.id from public.scheduled_posts sp
    where sp.publication_status='publishing'
      and sp.publish_claimed_at<now()-p_older_than
    order by sp.publish_claimed_at
    for update skip locked
  loop
    perform public.record_post_publish_uncertain_v7(v_id,
      'Publisher stopped before recording the result. Inspect the provider account before any new attempt.');
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;

comment on function public.record_post_publish_uncertain_v7(uuid,text) is
  'Terminal automatic hold after an ambiguous provider write. An account read is required before a separate reconciliation can clear it.';
comment on function public.record_post_publish_failure(uuid,text,boolean,integer) is
  'Record a known failure only while publishing; an uncertain outcome cannot be returned to the automatic queue.';
comment on function public.reap_stale_publish_claims(interval) is
  'Moves abandoned publishing claims to uncertain; never requeues an effect that may have reached the provider.';
select public.lock_down_definer_functions();
commit;

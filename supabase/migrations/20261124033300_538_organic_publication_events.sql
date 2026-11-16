-- A scheduled post's current status cannot explain an earlier failure or
-- retry. Record the transitions as they happen; older rows get one explicitly
-- labelled snapshot, never a reconstructed history.
create table public.post_publication_events_v6 (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null,
  client_id uuid,
  asset_id uuid,
  ref_number text,
  media_type text not null,
  channel text not null,
  platform text,
  event text not null check (event in (
    'legacy_snapshot','scheduled','rescheduled','attempted','retry_queued',
    'failed','published','removed_from_calendar')),
  publication_status text not null,
  attempt_number integer not null,
  scheduled_at timestamptz not null,
  external_id text,
  external_url text,
  detail text,
  actor_role text,
  occurred_at timestamptz not null default clock_timestamp()
);
create index post_publication_events_client_idx
  on public.post_publication_events_v6(client_id,occurred_at desc,id desc);
create index post_publication_events_post_idx
  on public.post_publication_events_v6(post_id,occurred_at desc,id desc);

insert into public.post_publication_events_v6
  (post_id,client_id,asset_id,ref_number,media_type,channel,platform,event,publication_status,
   attempt_number,scheduled_at,external_id,external_url,detail,actor_role,occurred_at)
select id,client_id,asset_id,ref_number,media_type::text,channel::text,platform::text,'legacy_snapshot',
  publication_status,publish_attempts,scheduled_at,external_id,external_url,
  'State observed when publication history tracking began; earlier transitions are unknown.',
  'migration',clock_timestamp()
from public.scheduled_posts;

create function public.record_post_publication_event_v6()
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
    (post_id,client_id,asset_id,ref_number,media_type,channel,platform,event,publication_status,
     attempt_number,scheduled_at,external_id,external_url,detail,actor_role)
  values (v_row.id,v_row.client_id,v_row.asset_id,v_row.ref_number,v_row.media_type::text,v_row.channel::text,
    v_row.platform::text,v_event,v_row.publication_status,v_row.publish_attempts,
    v_row.scheduled_at,v_row.external_id,v_row.external_url,v_row.failure_reason,
    coalesce(auth.role(),'unknown'));
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger post_publication_event_insert_v6
  after insert on public.scheduled_posts for each row
  execute function public.record_post_publication_event_v6();
create trigger post_publication_event_update_v6
  after update on public.scheduled_posts for each row
  execute function public.record_post_publication_event_v6();
create trigger post_publication_event_delete_v6
  before delete on public.scheduled_posts for each row
  execute function public.record_post_publication_event_v6();

create function public.prevent_post_publication_event_change_v6()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  raise exception 'Publication events are append-only.' using errcode='42501';
end $$;
create trigger post_publication_events_immutable_v6
  before update or delete on public.post_publication_events_v6 for each row
  execute function public.prevent_post_publication_event_change_v6();

alter table public.post_publication_events_v6 enable row level security;
create policy post_publication_events_read_v6
  on public.post_publication_events_v6 for select to authenticated
  using (client_id is not null and public.can_access_client(client_id));
revoke all on public.post_publication_events_v6 from public,anon,authenticated;
grant select on public.post_publication_events_v6 to authenticated,service_role;
revoke all on function public.record_post_publication_event_v6() from public,anon,authenticated,service_role;
revoke all on function public.prevent_post_publication_event_change_v6() from public,anon,authenticated,service_role;

comment on table public.post_publication_events_v6 is
  'Append-only observed post state transitions. Legacy snapshots state only what was visible at migration time; a recorded published state is not provider read-back.';

-- Provider acknowledgement and account read-back are separate facts.
-- Preserve every read attempt; an unavailable read never queues another post.
begin;
create table public.organic_provider_readback_events_v8 (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.scheduled_posts(id) on delete restrict,
  client_id uuid not null references public.clients(id) on delete restrict,
  frame_position integer not null default 0 check (frame_position >= 0),
  platform public.post_platform not null,
  external_id text not null check (length(btrim(external_id)) between 1 and 255),
  expected_account_ref text not null check (length(btrim(expected_account_ref)) between 1 and 255),
  observed_account_ref text,
  state text not null check (state in ('verified','unavailable','mismatch')),
  provider_url text,
  checked_at timestamptz not null default clock_timestamp(),
  check ((state='unavailable' and observed_account_ref is null and provider_url is null)
    or (state='mismatch' and observed_account_ref is not null and provider_url is null)
    or (state='verified' and observed_account_ref=expected_account_ref))
);
create index organic_provider_readback_events_v8_latest
  on public.organic_provider_readback_events_v8(post_id,frame_position,checked_at desc,id desc);
alter table public.organic_provider_readback_events_v8 enable row level security;
create policy organic_provider_readback_events_v8_scoped_read
  on public.organic_provider_readback_events_v8 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.organic_provider_readback_events_v8
  from public,anon,authenticated,service_role;
grant select on public.organic_provider_readback_events_v8 to authenticated,service_role;
create trigger organic_provider_readback_events_v8_append_only
  before update or delete on public.organic_provider_readback_events_v8
  for each row execute function public.reject_approval_ledger_mutation_v6();
create trigger organic_provider_readback_events_v8_no_truncate
  before truncate on public.organic_provider_readback_events_v8
  for each statement execute function public.reject_approval_ledger_mutation_v6();

create function public.record_organic_provider_readback_v8(
  p_post_id uuid,p_frame_position integer,p_external_id text,
  p_expected_account_ref text,p_observed_account_ref text,p_state text,
  p_provider_url text default null)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare
  p public.scheduled_posts%rowtype;
  v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Only the publisher may record provider read-back.' using errcode='42501';
  end if;
  if p_frame_position is null or p_frame_position<0
    or nullif(btrim(coalesce(p_external_id,'')),'') is null
    or nullif(btrim(coalesce(p_expected_account_ref,'')),'') is null
    or p_state not in ('verified','unavailable','mismatch') then
    raise exception 'Provider read-back fields are incomplete.' using errcode='23514';
  end if;
  select * into p from public.scheduled_posts where id=p_post_id;
  if not found or p.channel is distinct from 'organic'::public.post_channel
    or p.platform not in ('instagram','facebook') then
    raise exception 'Only an organic Meta post can be read back.' using errcode='23514';
  end if;
  if p_frame_position=0 then
    if p.publication_status is distinct from 'published'
      or p.external_id is distinct from p_external_id then
      raise exception 'Provider acknowledgement is missing or different.' using errcode='23514';
    end if;
  elsif not exists(select 1 from public.post_frame_publications f
      where f.post_id=p.id and f.client_id=p.client_id
        and f.position=p_frame_position and f.external_id=p_external_id) then
    raise exception 'Story frame acknowledgement is missing or different.' using errcode='23514';
  end if;
  if not exists(select 1 from public.organic_publication_packages_v6 pkg
      where pkg.scheduled_post_id=p.id and pkg.client_id=p.client_id
        and pkg.manifest->>'platform'=p.platform::text
        and pkg.manifest->>'account_ref'=p_expected_account_ref) then
    raise exception 'The read-back account has no frozen publication package.'
      using errcode='23514';
  end if;
  if (p_state='unavailable' and
        (p_observed_account_ref is not null or p_provider_url is not null))
    or (p_state='mismatch' and
        (nullif(btrim(coalesce(p_observed_account_ref,'')),'') is null
          or p_provider_url is not null))
    or (p_state='verified' and
        p_observed_account_ref is distinct from p_expected_account_ref)
    or (p_provider_url is not null and
      (p.platform='instagram' and p_provider_url !~
        '^https://(www\.)?instagram\.com/'
       or p.platform='facebook' and p_provider_url !~
        '^https://(www\.)?facebook\.com/')) then
    raise exception 'Read-back state or provider URL is inconsistent.' using errcode='23514';
  end if;
  insert into public.organic_provider_readback_events_v8
    (post_id,client_id,frame_position,platform,external_id,
      expected_account_ref,observed_account_ref,state,provider_url)
  values (p.id,p.client_id,p_frame_position,p.platform,p_external_id,
    p_expected_account_ref,p_observed_account_ref,p_state,p_provider_url)
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.record_organic_provider_readback_v8(
  uuid,integer,text,text,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.record_organic_provider_readback_v8(
  uuid,integer,text,text,text,text,text) to service_role;

create view public.organic_provider_readback_latest_v8
with (security_invoker=true) as
select distinct on (post_id,frame_position)
  id,post_id,client_id,frame_position,platform,external_id,
  expected_account_ref,observed_account_ref,state,provider_url,checked_at
from public.organic_provider_readback_events_v8
order by post_id,frame_position,checked_at desc,id desc;
revoke all on public.organic_provider_readback_latest_v8
  from public,anon,authenticated,service_role;
grant select on public.organic_provider_readback_latest_v8 to authenticated,service_role;
select public.lock_down_definer_functions();
commit;

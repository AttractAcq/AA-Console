-- Revisit acknowledged Meta objects with GET only. An unavailable read is
-- never a reason to send the post again. The schedule only enqueues read-only
-- GET work; it never changes an outward publication switch or post state.
begin;

create view public.organic_provider_readback_retry_due_v8
with (security_invoker=true) as
with acknowledged as (
  select p.id as post_id,p.client_id,p.platform,0 as frame_position,
    p.external_id,p.published_at as acknowledged_at
  from public.scheduled_posts p
  where p.channel='organic' and p.publication_status='published'
    and p.platform in ('instagram','facebook') and p.external_id is not null
    and not exists (select 1 from public.post_frame_publications f
      where f.post_id=p.id)
  union all
  select f.post_id,f.client_id,p.platform,f.position,f.external_id,
    f.published_at
  from public.post_frame_publications f
  join public.scheduled_posts p on p.id=f.post_id and p.client_id=f.client_id
  where p.channel='organic' and p.platform in ('instagram','facebook')
)
select a.post_id,a.client_id,a.platform::text as platform,a.frame_position,
  a.external_id,pkg.account_ref as expected_account_ref,
  latest.checked_at as last_checked_at
from acknowledged a
join lateral (
  select p.manifest->>'account_ref' as account_ref
  from public.organic_publication_packages_v6 p
  where p.scheduled_post_id=a.post_id and p.client_id=a.client_id
    and p.manifest->>'platform'=a.platform::text
  order by p.registered_at desc,p.id desc limit 1
) pkg on nullif(btrim(pkg.account_ref),'') is not null
join public.client_integrations ci on ci.client_id=a.client_id
  and ci.provider=case when a.platform='instagram' then 'instagram' else 'meta' end
  and ci.status in ('connected','active','expiring')
  and ci.credential_secret_id is not null
  and case when a.platform='instagram' then ci.credential_label else ci.meta_page_id end
      =pkg.account_ref
  and (select count(*) from public.client_integrations other
    where other.client_id=a.client_id and other.provider=ci.provider)=1
left join lateral (
  select e.id,e.state,e.checked_at
  from public.organic_provider_readback_events_v8 e
  where e.post_id=a.post_id and e.frame_position=a.frame_position
    and e.external_id=a.external_id and e.expected_account_ref=pkg.account_ref
  order by e.checked_at desc,e.id desc limit 1
) latest on true
where a.acknowledged_at >= now()-interval '14 days'
  and a.acknowledged_at <= now()-interval '15 minutes'
  and (latest.id is null or (latest.state='unavailable'
    and latest.checked_at<=now()-interval '15 minutes'))
  and (select count(*) from public.organic_provider_readback_events_v8 e
    where e.post_id=a.post_id and e.frame_position=a.frame_position
      and e.external_id=a.external_id and e.expected_account_ref=pkg.account_ref)<6;
revoke all on public.organic_provider_readback_retry_due_v8
  from public,anon,authenticated,service_role;
grant select on public.organic_provider_readback_retry_due_v8 to service_role;

insert into public.agents
  (agent_key,name,initials,domain,description,requires_upstream,config,paused)
values ('organic_readback_reconciler','Organic Provider Readback','OR','content',
  'Rechecks acknowledged Meta post IDs through GET; never publishes or changes post status.',
  '{}','{}',false)
on conflict (agent_key) do nothing;

create unique index organic_readback_one_active_job_v8
  on public.agent_jobs(agent_key)
  where agent_key='organic_readback_reconciler'
    and status in ('queued','claimed','running','paused');

create function public.enqueue_organic_readback_reconciliation_v8()
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare v_job uuid;
begin
  if session_user <> 'postgres' and auth.role() is distinct from 'service_role' then
    raise exception 'Only the scheduler or runtime may enqueue readback.' using errcode='42501';
  end if;
  if not exists(select 1 from public.organic_provider_readback_retry_due_v8 limit 1)
    or exists(select 1 from public.agent_jobs where agent_key='organic_readback_reconciler'
      and status in ('queued','claimed','running','paused')) then return null; end if;
  insert into public.agent_jobs(agent_key,params)
    values ('organic_readback_reconciler','{}'::jsonb)
    on conflict do nothing returning id into v_job;
  return v_job;
end $$;
revoke all on function public.enqueue_organic_readback_reconciliation_v8()
  from public,anon,authenticated,service_role;
grant execute on function public.enqueue_organic_readback_reconciliation_v8() to service_role;

select cron.schedule('organic-provider-readback-reconcile','*/15 * * * *',
  $cron$select public.enqueue_organic_readback_reconciliation_v8();$cron$);
select public.lock_down_definer_functions();
commit;

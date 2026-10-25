-- G02, the sweep: register the courier and schedule it.
--
-- Separate from 249 because this is the part that makes messages actually
-- leave, and it is the part worth being able to point at when asking "what
-- turned this on".

create or replace function public.enqueue_outbound_sweep()
returns uuid language plpgsql security definer
set search_path to 'public' as $$
declare v_job uuid;
begin
  -- One sweep in flight. A second would claim the rows the first already
  -- leased, which is harmless, and burn a worker, which is not.
  if exists (select 1 from agent_jobs
              where agent_key = 'outbound_courier'
                and status in ('queued', 'claimed', 'running')) then
    return null;
  end if;
  -- Nothing unblocked means no job. The cron running every five minutes
  -- against an empty queue should cost one query, not a worker.
  if not exists (select 1 from outbound_message_due
                  where blocker is null and status in ('queued', 'sending')) then
    return null;
  end if;
  insert into agent_jobs (agent_key, params)
  values ('outbound_courier', jsonb_build_object('limit', 10))
  returning id into v_job;
  return v_job;
end $$;

revoke all on function public.enqueue_outbound_sweep() from public, anon;
grant execute on function public.enqueue_outbound_sweep() to authenticated, service_role;

insert into agents (agent_key, name, initials, domain, description, requires_upstream) values
  ('outbound_courier', 'Outbound Courier', 'OC', null,
   'Sends approved messages to individual leads. Decides nothing: consent, suppression, the approval and the daily cap are all re-checked inside the claim, so this worker only carries what the database has already cleared.',
   array[]::text[])
on conflict (agent_key) do update
  set name = excluded.name, initials = excluded.initials,
      description = excluded.description, requires_upstream = excluded.requires_upstream;

-- Every five minutes. Slower than the magnet courier on purpose: nobody is
-- sitting waiting for a nurture message the way they wait for a file they
-- just asked for, and a slower cadence makes a runaway sequence easier to
-- catch before it has sent two hundred of them.
select cron.unschedule('outbound-sweep')
 where exists (select 1 from cron.job where jobname = 'outbound-sweep');
select cron.schedule('outbound-sweep', '*/5 * * * *',
  $cron$ select public.enqueue_outbound_sweep(); $cron$);

select cron.unschedule('reap-stale-outbound-claims')
 where exists (select 1 from cron.job where jobname = 'reap-stale-outbound-claims');
select cron.schedule('reap-stale-outbound-claims', '55 * * * *',
  $cron$ select public.reap_stale_outbound_claims(); $cron$);

-- The campaign-level action stays unsupported: a campaign saying "message
-- this campaign's leads" needs the sequence layer to decide which leads and
-- when, which is its own slice. The send path it would use now exists.
update public.campaign_action_executors
   set note = 'The governed send path exists: an approved message template version goes to one consenting, unsuppressed person through the outbound courier. What is still missing is the campaign-level decision of which leads and when, which is the nurture sequence layer.'
 where action_key = 'lead_message';

select lock_down_definer_functions();

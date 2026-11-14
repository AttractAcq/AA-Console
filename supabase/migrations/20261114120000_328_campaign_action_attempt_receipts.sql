-- Phase 2: one durable outcome per campaign action attempt. Approval remains
-- in the canonical AAL2 ledger; this table records what the worker tried.
begin;

create table public.campaign_action_attempts_v6 (
  execution_id uuid not null references public.campaign_action_executions(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  approval_id uuid not null references public.campaign_action_approvals(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  action_key text not null,
  artifact_version_hash text not null,
  status text not null check (status in ('executing','executed','failed','abandoned')),
  started_at timestamptz not null,
  finished_at timestamptz,
  external_id text,
  external_url text,
  result jsonb,
  error text,
  legacy_inferred boolean not null default false,
  primary key (execution_id,attempt_number),
  check ((status = 'executing' and finished_at is null)
    or (status <> 'executing' and finished_at is not null))
);
create index campaign_action_attempts_v6_client_idx
  on public.campaign_action_attempts_v6(client_id,started_at desc);
alter table public.campaign_action_attempts_v6 enable row level security;
create policy campaign_action_attempts_v6_read
  on public.campaign_action_attempts_v6 for select to authenticated
  using (public.is_admin() or auth.uid() = public.active_video_approval_manager(client_id));
revoke all on public.campaign_action_attempts_v6 from public,anon,authenticated,service_role;
grant select on public.campaign_action_attempts_v6 to authenticated,service_role;

create function public.sync_campaign_action_attempt_v6()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
begin
  if new.attempts < 1 then
    raise exception 'An execution attempt needs a positive attempt number.' using errcode = '23514';
  end if;
  if new.status = 'executing' then
    if tg_op = 'INSERT' or old.status is distinct from 'executing'
      or old.attempts is distinct from new.attempts then
      insert into public.campaign_action_attempts_v6
        (execution_id,attempt_number,approval_id,client_id,action_key,
          artifact_version_hash,status,started_at)
      values (new.id,new.attempts,new.approval_id,new.client_id,new.action_key,
        new.artifact_version_hash,'executing',coalesce(new.claimed_at,now()));
    end if;
  elsif new.status in ('executed','failed','abandoned') then
    if new.status = 'executed' and new.action_key in ('page_deploy','budget_change')
      and nullif(btrim(coalesce(new.external_id,'')),'') is null
      and nullif(btrim(coalesce(new.external_url,'')),'') is null then
      raise exception 'An external campaign action needs an observed provider reference.'
        using errcode = '23514';
    end if;
    update public.campaign_action_attempts_v6 a set
      status = new.status,
      finished_at = coalesce(a.finished_at,new.executed_at,now()),
      external_id = new.external_id,
      external_url = new.external_url,
      result = new.result,
      error = new.last_error
    where a.execution_id = new.id and a.attempt_number = new.attempts
      and a.status in ('executing','failed');
    if not found and (tg_op = 'INSERT' or old.status is distinct from new.status) then
      raise exception 'An outcome has no matching started attempt.' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.sync_campaign_action_attempt_v6()
  from public,anon,authenticated,service_role;
create trigger campaign_action_attempt_receipt_v6
  after insert or update of status,attempts,external_id,external_url,result,last_error
  on public.campaign_action_executions for each row
  execute function public.sync_campaign_action_attempt_v6();

-- Older execution rows have only an aggregate attempt counter. Preserve an
-- in-flight attempt so its eventual outcome can be recorded, and label it as
-- inferred from the lifecycle row rather than observed by this trigger.
insert into public.campaign_action_attempts_v6
  (execution_id,attempt_number,approval_id,client_id,action_key,
    artifact_version_hash,status,started_at,legacy_inferred)
select e.id,e.attempts,e.approval_id,e.client_id,e.action_key,
  e.artifact_version_hash,'executing',coalesce(e.claimed_at,e.created_at),true
from public.campaign_action_executions e
where e.status = 'executing' and e.attempts > 0;

select public.lock_down_definer_functions();
commit;

-- Scoped ideation writes campaign_id itself. The original trigger returned
-- early for that case, leaving campaign_position null and failing the pair
-- constraint. Position both implicit and explicit campaign assignments.
create or replace function assign_generated_idea_campaign()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_campaign uuid;
  v_reserved integer;
begin
  if new.job_id is null then return new; end if;
  select nullif(params->>'campaign_id', '')::uuid into v_campaign
    from agent_jobs where id = new.job_id and agent_key = 'ideation' and client_id = new.client_id;
  if v_campaign is null then return new; end if;
  if new.campaign_id is not null and new.campaign_id <> v_campaign then
    raise exception 'Generated idea campaign does not match its job';
  end if;
  select case when content_ideas_generated_at is null then content_count else 0 end
    into v_reserved
    from client_campaigns
   where id = v_campaign and client_id = new.client_id and built_at is not null and archived_at is null
   for update;
  if not found then raise exception 'Ideation campaign is no longer available'; end if;
  new.campaign_id := v_campaign;
  if new.campaign_position is null then
    select greatest(coalesce(v_reserved, 0), coalesce(max(campaign_position), 0)) + 1
      into new.campaign_position from client_ideas where campaign_id = v_campaign;
  end if;
  return new;
end;
$$;

-- A package must not spend on a campaign the scoped ideation contract cannot
-- attach ideas to. Check on the new run only, so an idempotent retry of an
-- existing package is still readable after its campaign is later archived.
create function guard_daily_workflow_campaign()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'daily_content_package' and not exists (
    select 1 from client_campaigns c where c.id = new.campaign_id
      and c.client_id = new.client_id and c.built_at is not null
      and c.archived_at is null and c.status in ('planning', 'live')
  ) then
    raise exception 'Daily package needs a built, available campaign';
  end if;
  return new;
end;
$$;
create trigger guard_daily_workflow_campaign_after_insert
after insert on workflow_runs for each row execute function guard_daily_workflow_campaign();
select lock_down_definer_functions();

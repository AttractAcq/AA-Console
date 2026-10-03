-- The paid path when there is no usable token.
--
-- meta_build needs a Meta credential, and the credential is the thing that
-- breaks: a locked-out login, an expired system user, an account not yet
-- shared with us. The campaign is fully specified before any of that matters,
-- so this registers the agent that writes the build out for a person to create
-- in Ads Manager by hand — from the same payload builders meta_build sends, so
-- the two cannot disagree about an objective, a budget or a special ad
-- category.
--
-- Numbered 140 rather than 134: migrations 134 to 139 exist on other branches
-- and are not merged yet. Files are applied in timestamp order, so a gap is
-- harmless and a reused number is not.
--
-- Nothing here can reach Meta. The runner imports no transport, reads no
-- credential, and writes nothing but its own job events: the Meta ids still
-- come back from the person who built it, through the campaign's own form,
-- because only they know what Meta issued.

insert into agents (agent_key, name, initials, domain, description, requires_upstream, requires_input)
values
  ('meta_build_sheet', 'Meta Build Sheet', 'BS', 'conversion',
   'Writes a campaign''s paused Meta build out for a person to create in Ads Manager by hand, for when there is no usable Meta token. Reads only; never calls Meta.',
   '{}', true)
on conflict (agent_key) do nothing;

-- The one way the console asks for a sheet.
--
-- Shaped like request_meta_build and guarded the same way, for the same
-- reason the build is: a second request while one is queued or running is
-- only noise, and the same check keeps the two entry points consistent. It
-- does not take the campaign row lock, because nothing here writes to it.
create or replace function request_meta_build_sheet(p_campaign_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  c     client_campaigns%rowtype;
  v_job uuid;
begin
  select * into c from client_campaigns where id = p_campaign_id;
  if c.id is null then
    raise exception 'That campaign no longer exists.';
  end if;
  if not (auth.role() = 'service_role' or can_access_client(c.client_id)) then
    raise exception 'Not permitted for this client';
  end if;

  if exists (
    select 1 from agent_jobs j
     where j.agent_key = 'meta_build_sheet'
       and j.input_table = 'client_campaigns'
       and j.input_id = c.id
       and j.status in ('queued', 'claimed', 'running')
  ) then
    raise exception 'A build sheet for this campaign is already queued or running.';
  end if;

  v_job := enqueue_agent_job_internal(
    'meta_build_sheet', c.client_id, 'client_campaigns', c.id, auth.uid(),
    '{}'::jsonb, 'Queued: write the manual build sheet'
  );
  return v_job;
end;
$$;

revoke execute on function request_meta_build_sheet(uuid) from public, anon;
grant  execute on function request_meta_build_sheet(uuid) to authenticated, service_role;

comment on function request_meta_build_sheet(uuid) is
  'Queues the manual Meta build sheet for one campaign. Reads only: writes no Meta ids and sends nothing to Meta.';

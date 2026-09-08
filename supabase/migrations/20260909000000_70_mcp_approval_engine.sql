-- Phase 6: durable human waits and same-logical-execution continuation.
-- Sec review before merge. No production apply / Railway deploy from this change.
alter table mcp_internal.mcp_content_requests
  add column approval_execution_id text;
create unique index mcp_content_one_resume_idx
  on mcp_internal.mcp_content_requests(bot_id, approval_execution_id)
  where approval_execution_id is not null;

-- Current outcome projected from Console decisions, never a Bot decision write.
create or replace function mcp_internal.get_approval(
  p_bot_id text, p_client_id uuid, p_execution_id text
) returns jsonb language plpgsql volatile security definer
set search_path = mcp_internal, public as $$
declare
  r mcp_internal.mcp_content_requests;
  a client_media_assets;
  d client_asset_reviews;
  s mcp_internal.mcp_content_requests;
  v_state text;
  v_revision boolean;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  select * into r from mcp_internal.mcp_content_requests
    where bot_id = p_bot_id and execution_id = p_execution_id
      and tool = 'content.request_approval';
  if not found then
    raise exception using message = 'approval_not_found', errcode = 'P0001';
  end if;
  if r.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;
  -- Validate all persisted resource ownership before reading decision evidence.
  perform mcp_internal.resolve_content_target(p_client_id, r.idea_id, r.brief_id, r.asset_id);
  select * into a from client_media_assets
    where client_id = p_client_id and
      (id = r.asset_id or (r.asset_id is null and brief_id = r.brief_id))
    order by (review_status = 'approved') desc, created_at desc, id
    limit 1;
  select * into d from client_asset_reviews where asset_id = a.id
    order by created_at desc, id desc limit 1;
  select * into s from mcp_internal.mcp_content_requests
    where bot_id = p_bot_id and client_id = p_client_id
      and approval_execution_id = p_execution_id;
  select exists (
    select 1 from client_briefs b where b.id = r.brief_id and b.status = 'draft'
      and exists (select 1 from mcp_internal.mcp_content_requests x
        where x.client_id = p_client_id and x.brief_id = b.id
          and x.tool = 'content.request_revision')
  ) into v_revision;
  v_state := case
    when v_revision then 'needs_revision'
    when a.id is null then 'awaiting_production'
    when a.review_status = 'rejected' then 'rejected'
    when a.review_status = 'approved' and d.decision = 'approved' and d.reviewed_by is not null
      then case when s.execution_id is null then 'approved' else 'resumed' end
    else 'waiting_for_human' end;
  return jsonb_build_object(
    'execution_id', r.execution_id, 'request_id', r.request_id,
    'client_id', r.client_id, 'idea_id', r.idea_id, 'brief_id', r.brief_id,
    'asset_id', r.asset_id, 'approved_asset_id', case when v_state in ('approved','resumed') then a.id end,
    'requested_at', r.created_at, 'state', v_state,
    'decision', case when d.id is null then null else jsonb_build_object(
      'id', d.id, 'asset_id', d.asset_id, 'decision', d.decision,
      'reviewed_by', d.reviewed_by, 'created_at', d.created_at) end,
    'resume', case when s.execution_id is null then null else s.result || jsonb_build_object(
      'execution_id', s.execution_id, 'request_id', s.request_id, 'created_at', s.created_at) end
  );
end;
$$;

create or replace function mcp_internal.request_approval(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_idea_id uuid, p_brief_id uuid, p_asset_id uuid, p_summary text default null
)
returns jsonb
language plpgsql
security definer
set search_path = mcp_internal, public
as $$
declare
  v record;
  v_payload jsonb;
  v_existing jsonb;
  v_result jsonb;
  v_brief client_briefs;
  v_asset client_media_assets;
  v_queue text;
  v_brief_status text;
begin
  -- Sec Phase 5: active bot + mcp_bot_clients grant. Never can_access_client.
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  if p_summary is not null and length(p_summary) > 4000 then
    raise exception using message = 'invalid_request', errcode = 'P0001';
  end if;
  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'idea_id', p_idea_id, 'brief_id', p_brief_id, 'asset_id', p_asset_id,
    'summary', p_summary
  ));
  v_existing := mcp_internal.take_content_request(
    p_bot_id, p_execution_id, 'content.request_approval', p_client_id, v_payload);
  if v_existing is not null then
    return v_existing || jsonb_build_object('approval', jsonb_build_object(
      'execution_id', p_execution_id, 'request_id', (select request_id from mcp_internal.mcp_content_requests
        where bot_id = p_bot_id and execution_id = p_execution_id)));
  end if;

  select * into v from mcp_internal.resolve_content_target(p_client_id, p_idea_id, p_brief_id, p_asset_id);
  v_brief := v.brief;
  v_asset := v.asset;

  if v_asset.id is not null then
    if v_asset.review_status = 'rejected' then
      raise exception using message = 'invalid_asset_status', errcode = 'P0001';
    end if;
    v_queue := case
      when v_asset.review_status = 'approved' then 'already_approved'
      else 'console_approvals'
    end;
    v_brief_status := v_brief.status;
  elsif v_brief.id is not null then
    if v_brief.status = 'rejected' then
      raise exception using message = 'invalid_brief_status', errcode = 'P0001';
    end if;
    if v_brief.status = 'draft' then
      update client_briefs set status = 'approved' where id = v_brief.id;
      v_brief_status := 'approved';
    else
      v_brief_status := v_brief.status;
    end if;
    v_queue := 'brief_ready_for_build';
  else
    raise exception using message = 'brief_not_found', errcode = 'P0001';
  end if;

  v_result := jsonb_build_object(
    'client_id', p_client_id,
    'approval', jsonb_build_object('execution_id', p_execution_id, 'request_id', p_request_id),
    'idea_id', v.idea_id,
    'brief_id', v.brief_id,
    'asset_id', v.asset_id,
    'brief_status', v_brief_status,
    'queue', v_queue,
    'message', case v_queue
      when 'console_approvals' then
        'Asset is in the Console approvals queue. Human review_media_asset required. Bot cannot approve.'
      when 'already_approved' then
        'Asset is already approved. content.create_repurpose_plan is available.'
      else
        'Brief marked approved for human Approve & Build. Bot did not produce or approve an asset.'
    end,
    'replayed', false
  );
  insert into mcp_internal.mcp_content_requests (
    bot_id, execution_id, request_id, tool, client_id,
    idea_id, brief_id, asset_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'content.request_approval', p_client_id,
    v.idea_id, v.brief_id, v.asset_id, v_payload, v_result
  );
  return v_result;
end;
$$;

create or replace function mcp_internal.get_production_status(
  p_bot_id text, p_client_id uuid,
  p_idea_id uuid default null, p_brief_id uuid default null, p_asset_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = mcp_internal, public
as $$
declare
  v record;
  v_assets jsonb := '[]'::jsonb;
  v_jobs jsonb := '[]'::jsonb;
  v_actions jsonb := '[]'::jsonb;
  v_generations jsonb := '[]'::jsonb;
  v_dispatches jsonb := '[]'::jsonb;
  v_assignments jsonb := '[]'::jsonb;
  v_approved uuid;
  v_pending integer := 0;
  v_rejected integer := 0;
  v_revision boolean := false;
  v_blocked text;
  v_ready boolean := false;
  v_approvals jsonb := '[]'::jsonb;
  v_request record;
  v_wait jsonb;
begin
  -- Sec Phase 5: active bot + mcp_bot_clients grant. Never can_access_client.
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  select * into v from mcp_internal.resolve_content_target(p_client_id, p_idea_id, p_brief_id, p_asset_id);

  if v.brief_id is not null or v.asset_id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id, 'brief_id', a.brief_id, 'ref_number', a.ref_number,
      'media_type', a.media_type, 'title', a.title,
      'review_status', a.review_status, 'created_at', a.created_at
    ) order by a.created_at desc), '[]'::jsonb),
           count(*) filter (where a.review_status = 'pending'),
           count(*) filter (where a.review_status = 'rejected'),
           (array_agg(a.id) filter (where a.review_status = 'approved'))[1]
      into v_assets, v_pending, v_rejected, v_approved
      from client_media_assets a
     where a.client_id = p_client_id
       and ((v.asset_id is not null and a.id = v.asset_id)
         or (v.asset_id is null and a.brief_id = v.brief_id));

    select coalesce(jsonb_agg(jsonb_build_object(
      'id', j.id, 'agent_key', j.agent_key, 'status', j.status,
      'error', j.error, 'created_at', j.created_at, 'completed_at', j.completed_at
    ) order by j.created_at desc), '[]'::jsonb)
      into v_jobs
      from agent_jobs j
     where j.client_id = p_client_id
       and (
         j.id = (v.brief).job_id
         or (j.input_table = 'client_ideas' and j.input_id = v.idea_id)
         or (j.input_table = 'client_media_assets' and j.input_id in (
           select id from client_media_assets where brief_id = v.brief_id
         ))
       );

    select coalesce(jsonb_agg(jsonb_build_object(
      'id', ja.id, 'member_id', ja.member_id, 'title', ja.title,
      'due_date', ja.due_date, 'completed_at', ja.completed_at
    ) order by ja.created_at desc), '[]'::jsonb)
      into v_assignments
      from job_assignments ja
     where ja.client_id = p_client_id and ja.brief_id = v.brief_id;

    if to_regclass('public.creative_generations') is not null then
      execute $q$
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', g.id, 'stage', g.stage, 'media_type', g.media_type,
          'asset_id', g.asset_id, 'error', g.error, 'created_at', g.created_at
        ) order by g.created_at desc), '[]'::jsonb)
          from creative_generations g
         where g.client_id = $1 and g.brief_id = $2
      $q$ into v_generations using p_client_id, v.brief_id;
    end if;

    if to_regclass('public.brief_dispatches') is not null then
      execute $q$
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', d.id, 'member_id', d.member_id, 'email_status', d.email_status,
          'created_at', d.created_at
        ) order by d.created_at desc), '[]'::jsonb)
          from brief_dispatches d
         where d.client_id = $1 and d.brief_id = $2
      $q$ into v_dispatches using p_client_id, v.brief_id;
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'tool', r.tool, 'created_at', r.created_at,
    'brief_id', r.brief_id, 'asset_id', r.asset_id
  ) order by r.created_at desc), '[]'::jsonb),
         exists (
           select 1 from mcp_internal.mcp_content_requests x
            where x.client_id = p_client_id
              and x.tool = 'content.request_revision'
              and (x.brief_id = v.brief_id or (v.brief_id is null and x.idea_id = v.idea_id))
         )
    into v_actions, v_revision
    from mcp_internal.mcp_content_requests r
   where r.client_id = p_client_id
     and (
       (v.brief_id is not null and r.brief_id = v.brief_id)
       or (v.idea_id is not null and r.idea_id = v.idea_id)
       or (v.asset_id is not null and r.asset_id = v.asset_id)
     );

  if v.idea_id is not null and (v.idea).status is distinct from 'briefed' and v.brief_id is null then
    v_blocked := 'idea_not_briefed';
  elsif v.brief_id is null and v.asset_id is null then
    v_blocked := 'brief_missing';
  elsif v_revision and (v.brief).status = 'draft' then
    v_blocked := 'brief_needs_revision';
  elsif v_rejected > 0 and v_approved is null then
    v_blocked := 'asset_rejected';
  elsif v_pending > 0 then
    v_blocked := 'awaiting_asset_approval';
  elsif v_approved is null then
    v_blocked := 'awaiting_production';
  else
    v_ready := true;
    v_blocked := null;
  end if;

  for v_request in
    select r.execution_id from mcp_internal.mcp_content_requests r
      where r.bot_id = p_bot_id and r.client_id = p_client_id
        and r.tool = 'content.request_approval'
        and ((v.asset_id is not null and (r.asset_id = v.asset_id or
              (r.asset_id is null and r.brief_id = v.brief_id)))
          or (v.asset_id is null and r.brief_id = v.brief_id))
      order by r.created_at desc, r.execution_id limit 50
  loop
    v_wait := mcp_internal.get_approval(p_bot_id, p_client_id, v_request.execution_id);
    v_approvals := v_approvals || jsonb_build_array(v_wait);
  end loop;
  -- A linked wait cannot be bypassed with an approved status lacking human evidence.
  if v_ready and exists (select 1 from jsonb_array_elements(v_approvals) w
      where w->>'state' not in ('approved', 'resumed')) then
    v_ready := false;
    v_blocked := 'awaiting_asset_approval';
  end if;

  return jsonb_build_object(
    'client_id', p_client_id,
    'idea', case when v.idea_id is null then null else mcp_internal.idea_json(v.idea, false) end,
    'brief', case when v.brief_id is null then null else mcp_internal.brief_json(v.brief) end,
    'assets', v_assets,
    'jobs', v_jobs,
    'assignments', v_assignments,
    'generations', v_generations,
    'dispatches', v_dispatches,
    'actions', v_actions,
    'approvals', v_approvals,
    'handoff', jsonb_build_object(
      'ready_for_distribution', v_ready,
      'blocked_on', v_blocked,
      'approved_asset_id', v_approved,
      'next', case
        when v_ready then
          'Ready for distribution. content.queue_distribution remains a Distribution Manager stub.'
        when v_blocked = 'idea_not_briefed' then 'content.generate_brief'
        when v_blocked = 'brief_missing' then 'content.generate_brief'
        when v_blocked = 'brief_needs_revision' then 'Inspect the revised brief, then content.request_approval'
        when v_blocked = 'asset_rejected' then 'content.request_revision'
        when v_blocked = 'awaiting_asset_approval' then
          'Human Console review (review_media_asset). Bot cannot approve.'
        else 'Await production (Approve & Build in Console, or an in-flight creative_build job).'
      end
    )
  );
end;
$$;

-- Root approval execution survives distinct gateway receipt IDs on continuation.
create or replace function mcp_internal.resume_approval(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_asset_id uuid, p_formats text[], p_approval_execution_id text
) returns jsonb language plpgsql volatile security definer
set search_path = mcp_internal, public as $$
declare
  r mcp_internal.mcp_content_requests;
  a client_media_assets;
  v_wait jsonb;
  v_step text;
  v_result jsonb;
  v_payload jsonb;
  v_existing jsonb;
begin
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  perform mcp_internal.require_mcp_ids(p_request_id, p_execution_id);
  perform mcp_internal.require_mcp_ids(p_request_id, p_approval_execution_id);
  select * into r from mcp_internal.mcp_content_requests
    where bot_id = p_bot_id and execution_id = p_approval_execution_id
      and tool = 'content.request_approval' for update;
  if not found then
    raise exception using message = 'approval_not_found', errcode = 'P0001';
  end if;
  if r.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;
  select * into a from client_media_assets where id = p_asset_id for update;
  if not found then
    raise exception using message = 'asset_not_found', errcode = 'P0001';
  end if;
  if a.client_id <> p_client_id then
    raise exception using message = 'client_mismatch', errcode = 'P0001';
  end if;
  if (r.asset_id is not null and r.asset_id <> a.id)
      or (r.asset_id is null and r.brief_id is distinct from a.brief_id) then
    raise exception using message = 'approval_resource_mismatch', errcode = 'P0001';
  end if;
  v_wait := mcp_internal.get_approval(p_bot_id, p_client_id, p_approval_execution_id);
  if v_wait->>'state' not in ('approved', 'resumed') or a.review_status <> 'approved'
      or not exists (select 1 from client_asset_reviews d where d.asset_id = a.id
        and d.reviewed_by is not null and d.decision = 'approved'
        and d.id = (select id from client_asset_reviews where asset_id = a.id
          order by created_at desc, id desc limit 1)) then
    raise exception using message = 'approval_required', errcode = 'P0001';
  end if;
  -- Reserve every incoming receipt durably as well as the canonical continuation.
  -- This prevents the same transport execution from being reused for another root.
  v_payload := jsonb_build_object('asset_id', p_asset_id, 'formats', to_jsonb(p_formats),
    'approval_execution_id', p_approval_execution_id);
  v_existing := mcp_internal.take_content_request(p_bot_id, p_execution_id,
    'content.create_repurpose_plan', p_client_id, v_payload);
  if v_existing is not null then return v_existing; end if;
  v_step := 'resume.' || md5(p_bot_id || ':' || p_approval_execution_id);
  v_result := mcp_internal.create_repurpose_plan(
    p_bot_id, p_request_id, v_step, p_client_id, p_asset_id, p_formats);
  v_result := v_result || jsonb_build_object('approval_execution_id', p_approval_execution_id);
  update mcp_internal.mcp_content_requests
    set approval_execution_id = p_approval_execution_id,
        result = v_result || jsonb_build_object('replayed', false)
    where bot_id = p_bot_id and execution_id = v_step;
  insert into mcp_internal.mcp_content_requests (
    bot_id, execution_id, request_id, tool, client_id, asset_id, payload, result
  ) values (
    p_bot_id, p_execution_id, p_request_id, 'content.create_repurpose_plan',
    p_client_id, p_asset_id, v_payload, v_result
  );
  return v_result;
end;
$$;

create or replace function public.mcp_resume_approval(
  p_bot_id text, p_request_id text, p_execution_id text, p_client_id uuid,
  p_asset_id uuid, p_formats text[], p_approval_execution_id text
) returns jsonb language plpgsql volatile security definer
set search_path = mcp_internal, public as $$
begin
  perform mcp_internal.require_service_role();
  perform mcp_internal.require_active_bot(p_bot_id);
  perform mcp_internal.require_bot_client_grant(p_bot_id, p_client_id);
  return mcp_internal.resume_approval(p_bot_id, p_request_id, p_execution_id,
    p_client_id, p_asset_id, p_formats, p_approval_execution_id);
end;
$$;
revoke all on function mcp_internal.get_approval(text,uuid,text) from public, anon, authenticated;
revoke all on function mcp_internal.resume_approval(text,text,text,uuid,uuid,text[],text) from public, anon, authenticated;
revoke all on function public.mcp_resume_approval(text,text,text,uuid,uuid,text[],text) from public, anon, authenticated;
grant execute on function mcp_internal.get_approval(text,uuid,text) to service_role;
grant execute on function mcp_internal.resume_approval(text,text,text,uuid,uuid,text[],text) to service_role;
grant execute on function public.mcp_resume_approval(text,text,text,uuid,uuid,text[],text) to service_role;

-- Reassert the locked boundaries without changing permission rows or human RPCs.
do $$ begin
  perform mcp_internal.assert_cos_prohibitions();
  if not exists (select 1 from mcp_internal.mcp_bot_permissions
      where bot_id = 'bot_production' and permission_pattern = 'content.*') then
    raise exception 'Production Manager content grant missing';
  end if;
end $$;

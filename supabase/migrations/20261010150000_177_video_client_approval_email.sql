-- The dashboard request is the durable approval task. Email is a best-effort
-- notification, queued after each request and recorded separately.
insert into agents (agent_key, name, initials, domain, description, requires_upstream, scheduled_only)
values ('client_approval_dispatch', 'Client Approval Dispatch', 'CA', 'content',
  'Emails a client when their SMM requests review of a finished video.', '{}', true)
on conflict (agent_key) do update set description = excluded.description,
  scheduled_only = excluded.scheduled_only;

alter table video_client_approval_requests
  add column job_id uuid references agent_jobs(id) on delete set null,
  add column email_status text not null default 'pending'
    check (email_status in ('pending', 'sent', 'failed', 'skipped')),
  add column email_error text,
  add column emailed_at timestamptz;

create or replace function queue_video_client_approval_email()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_client_id uuid;
  v_job_id uuid;
begin
  select client_id into v_client_id from client_media_assets where id = new.asset_id;
  insert into agent_jobs(agent_key, client_id, input_table, input_id, params, created_by)
  values ('client_approval_dispatch', v_client_id,
    'video_client_approval_requests', new.asset_id,
    jsonb_build_object('asset_id', new.asset_id), new.requested_by)
  returning id into v_job_id;
  update video_client_approval_requests set job_id = v_job_id,
    email_status = 'pending', email_error = null, emailed_at = null
    where asset_id = new.asset_id;
  return new;
end;
$$;
create trigger video_client_approval_queue_email
  after insert or update of requested_at on video_client_approval_requests
  for each row execute function queue_video_client_approval_email();

create or replace function video_client_approval_email_state(p_asset_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_client_id uuid;
  v_status text;
  v_error text;
begin
  select client_id into v_client_id from client_media_assets where id = p_asset_id;
  if v_client_id is null or not can_access_client(v_client_id) then
    raise exception 'Not permitted for this asset';
  end if;
  select email_status, email_error into v_status, v_error
    from video_client_approval_requests where asset_id = p_asset_id;
  return jsonb_build_object('status', v_status, 'error', v_error);
end;
$$;
revoke execute on function video_client_approval_email_state(uuid) from public, anon;
grant execute on function video_client_approval_email_state(uuid) to authenticated;

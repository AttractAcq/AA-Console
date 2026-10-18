-- The cut that replaces the editor handoff.
--
-- video_build ends at assembly.ts, a stub that hands a reel to a person by
-- email: "Clips are not composited here." This registers the agent that does
-- composite them — Claude writes an edit decision list, pure code validates
-- it, ffmpeg renders it, and what comes back is a 1080x1920 MP4 on the reel's
-- own asset row.
--
-- Nothing here reaches Higgsfield or any model. It registers an agent, adds
-- the two columns its output lands in, and gives the console one way to ask.
--
-- The edit is on the asset rather than the brief, because the asset is what
-- owns the frames the clips hang off and what a person approves. One asset,
-- one cut: a second request while one is queued is noise, and the guard says
-- so rather than quietly queueing a second render of the same thing.

alter table client_media_assets
  add column if not exists edit_plan jsonb,
  add column if not exists render_path text;

comment on column client_media_assets.edit_plan is
  'The validated edit decision list video_edit rendered from: segments, captions, transitions and the end card. Kept so a cut can be read back, compared or re-rendered without paying the planner again.';
comment on column client_media_assets.render_path is
  'client-media path of the assembled reel. Null until video_edit has produced one; the stills and clips stay on client_media_frames either way.';

insert into agents (agent_key, name, initials, domain, description, requires_upstream, requires_input)
values (
  'video_edit', 'Video Edit', 'VE', 'content',
  'Cuts a reel from its Higgsfield clips: a model writes the edit decision list, code validates it, ffmpeg renders 1080x1920. Falls back to the editor handoff when a cut cannot be validated.',
  '{}', true
)
on conflict (agent_key) do nothing;

-- The one way the console asks for a cut.
--
-- Guarded like request_meta_build: the caller must reach the client, and a
-- second request while one is in flight is refused rather than queued. The
-- readiness check is deliberately NOT here — whether the clips have landed is
-- the runner's to report, with a reason, in the job's own events. Refusing in
-- SQL would mean the answer never reaches the person who pressed the button.
create or replace function request_video_edit(p_asset_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  a     client_media_assets%rowtype;
  v_job uuid;
begin
  select * into a from client_media_assets where id = p_asset_id;
  if a.id is null then
    raise exception 'That asset no longer exists.';
  end if;
  if not (auth.role() = 'service_role' or can_access_client(a.client_id)) then
    raise exception 'Not permitted for this client';
  end if;
  if a.media_type is distinct from 'video' or a.content_format is distinct from 'reel' then
    raise exception 'Only a reel is cut here.';
  end if;

  if exists (
    select 1 from agent_jobs j
     where j.agent_key = 'video_edit'
       and j.input_table = 'client_media_assets'
       and j.input_id = a.id
       and j.status in ('queued', 'claimed', 'running')
  ) then
    raise exception 'A cut of this reel is already queued or running.';
  end if;

  v_job := enqueue_agent_job_internal(
    'video_edit', a.client_id, 'client_media_assets', a.id, auth.uid(),
    '{}'::jsonb, 'Queued: cut the reel from its clips'
  );
  return v_job;
end;
$$;

revoke execute on function request_video_edit(uuid) from public, anon;
grant  execute on function request_video_edit(uuid) to authenticated, service_role;

comment on function request_video_edit(uuid) is
  'Queues the reel cut for one asset. Refuses a second while one is in flight; says nothing about whether the clips are ready, which is the runner''s to report.';

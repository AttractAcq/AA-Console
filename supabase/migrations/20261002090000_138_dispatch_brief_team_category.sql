-- Lock the production hotfix for dispatch_brief_to_members.
--
-- Migration 95 (20260919180000_95_video_dual_briefs.sql) declared
--   v_need_cat text;
-- and then compared it against team_members.category, which is a
-- team_category enum:
--   if v_need_cat is not null and v_member.category is distinct from v_need_cat
--
-- Postgres has no team_category = text operator, so that line raises
--   ERROR 42883: operator does not exist: team_category = text
-- for every send that reaches the member loop. Not only the avatar and
-- editor roles: PL/pgSQL plans an IF condition as a single SQL expression,
-- so the operator has to resolve before any value is considered and
-- short-circuiting never gets the chance. 'full' fails too.
--
-- Production shows it. brief_dispatches holds one row from 5 September,
-- before migration 95, and then nothing until 25 September at 20:50:56 --
-- two minutes after the hotfix below was applied at 20:48:49. Nothing was
-- dispatched at all in between.
--
-- Production was hotfixed remotely as 127_fix_team_category_text_compare,
-- which was never committed: it exists in no branch of this repository. The
-- live function declares v_need_cat as team_category and casts the case
-- branches. This migration records that shape so a fresh replay of the git
-- history, a staging rebuild or a disaster restore cannot put the broken
-- text comparison back.
--
-- Historical migration 95 is left unchanged. CREATE OR REPLACE is idempotent
-- against the live hotfix, so applying this to production is a no-op there
-- and a repair everywhere else.

create or replace function dispatch_brief_to_members(
  p_brief_id     uuid,
  p_member_ids   uuid[],
  p_due_date     date default null,
  p_compensation numeric default null,
  p_brief_role   text default 'full'
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_brief     record;
  v_member    record;
  v_assign_id uuid;
  v_disp_id   uuid;
  v_job_id    uuid;
  v_count     integer := 0;
  v_role      text := coalesce(nullif(trim(p_brief_role), ''), 'full');
  -- The fix. An enum column is compared against an enum variable.
  v_need_cat  team_category;
begin
  if not is_admin() then
    raise exception 'Only an admin can send a brief.';
  end if;
  if p_member_ids is null or array_length(p_member_ids, 1) is null then
    raise exception 'Choose at least one person to send this to.';
  end if;
  if v_role not in ('avatar', 'editor', 'full') then
    raise exception 'brief_role must be avatar, editor, or full.';
  end if;

  select id, client_id, title, media_type, avatar_brief, editor_brief, body
    into v_brief
    from client_briefs where id = p_brief_id;
  if v_brief.id is null then
    raise exception 'That brief does not exist.';
  end if;

  -- Role sends are video-only. Image/text keep the legacy full dispatch.
  if v_role in ('avatar', 'editor') and v_brief.media_type is distinct from 'video' then
    raise exception 'Avatar and editor briefs are only for video.';
  end if;
  if v_role = 'avatar' and (v_brief.avatar_brief is null or length(trim(v_brief.avatar_brief)) = 0) then
    raise exception 'This video brief has no avatar brief yet.';
  end if;
  if v_role = 'editor' and (v_brief.editor_brief is null or length(trim(v_brief.editor_brief)) = 0) then
    raise exception 'This video brief has no editor brief yet.';
  end if;

  v_need_cat := case v_role
    when 'avatar' then 'avatars'::team_category
    when 'editor' then 'editors'::team_category
    else null
  end;

  for v_member in
    select id, name, category from team_members
     where id = any(p_member_ids) and active = true
  loop
    if v_member.category not in ('editors'::team_category, 'avatars'::team_category) then
      raise exception '% is not an editor or an avatar.', v_member.name;
    end if;
    if v_need_cat is not null and v_member.category is distinct from v_need_cat then
      raise exception '% is not in the % category required for this send.', v_member.name, v_need_cat;
    end if;

    insert into job_assignments (member_id, client_id, brief_id, title, due_date, compensation)
    values (v_member.id, v_brief.client_id, p_brief_id, v_brief.title, p_due_date, p_compensation)
    returning id into v_assign_id;

    insert into brief_dispatches (client_id, brief_id, member_id, assignment_id, sent_by, brief_role)
    values (v_brief.client_id, p_brief_id, v_member.id, v_assign_id, auth.uid(), v_role)
    on conflict (brief_id, member_id, brief_role) do update
      set assignment_id = excluded.assignment_id,
          email_status = 'pending',
          email_error = null,
          emailed_at = null,
          sent_by = excluded.sent_by
    returning id into v_disp_id;

    insert into agent_jobs (agent_key, client_id, params, created_by)
    values ('brief_dispatch', v_brief.client_id,
            jsonb_build_object('dispatch_id', v_disp_id), auth.uid())
    returning id into v_job_id;

    update brief_dispatches set job_id = v_job_id where id = v_disp_id;
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'None of those people are active team members.';
  end if;

  update client_briefs set status = 'in_production' where id = p_brief_id;
  return v_count;
end;
$$;

comment on function dispatch_brief_to_members(uuid, uuid[], date, numeric, text) is
  'Sends a brief to team members. p_brief_role is avatar, editor or full; one call sends one role. v_need_cat is team_category, not text: an enum column cannot be compared against a text variable.';

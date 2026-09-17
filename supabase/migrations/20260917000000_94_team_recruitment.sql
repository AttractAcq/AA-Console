-- Team → Recruitment P0.
--
-- Schema choice: do not invent a parallel brief/generation/media chain.
-- Hiring ads reuse client_briefs + creative_generations + creative_renders
-- + client_media_assets so build_brief_with_ai (mig 43 / the mig-93 shape)
-- keeps working unchanged. Isolation from paying-client campaigns is:
--   1. purpose = 'recruitment' (default on existing rows is 'client')
--   2. those rows live only on the Attract Acquisition house client
--      (clients.is_internal, already on the table)
--   3. Console client Briefs / Media / Approvals / Dist filter purpose off
--
-- Roles are a dedicated enum (editor | smm | avatar) as locked for P0 —
-- not team_category, which is plural (editors/avatars) and is the roster.
-- No recruitment.* MCP tools. No Distribution / Meta draft publish.

begin;

create type content_purpose as enum ('client', 'recruitment');
create type recruitment_role as enum ('editor', 'smm', 'avatar');

alter table client_briefs
  add column purpose content_purpose not null default 'client',
  add column recruitment_role recruitment_role,
  add column apply_url text,
  add column compensation_text text;

alter table client_briefs
  add constraint client_briefs_recruitment_shape check (
    (
      purpose = 'client'
      and recruitment_role is null
      and apply_url is null
      and compensation_text is null
    )
    or (
      purpose = 'recruitment'
      and recruitment_role is not null
      and apply_url is not null
      and media_type = 'image'
    )
  );

create index client_briefs_purpose_idx
  on client_briefs (purpose, created_at desc);

comment on column client_briefs.purpose is
  'client = paying-client delivery. recruitment = Attract Acquisition hiring ads. Never mix the two in campaign UIs.';
comment on column client_briefs.recruitment_role is
  'P0 hiring roles only: editor, smm, avatar. Null on client-purpose briefs.';
comment on column client_briefs.apply_url is
  'Where a candidate applies. URL field only — there is no in-app apply flow.';
comment on column client_briefs.compensation_text is
  'Optional copy shown on the ad (e.g. a day rate). Not a payroll figure.';

alter table client_media_assets
  add column purpose content_purpose not null default 'client';

create index client_media_assets_purpose_idx
  on client_media_assets (client_id, purpose, review_status);

comment on column client_media_assets.purpose is
  'Copied from the source brief on insert so review and export can filter recruitment without joining.';

-- Stamp purpose from the brief so AI and human uploads cannot forget the tag.
create or replace function stamp_media_purpose_from_brief()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_purpose content_purpose;
begin
  if new.brief_id is not null then
    select purpose into v_purpose from client_briefs where id = new.brief_id;
    if v_purpose is not null then
      new.purpose := v_purpose;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists cma_stamp_purpose on client_media_assets;
create trigger cma_stamp_purpose
  before insert on client_media_assets
  for each row execute function stamp_media_purpose_from_brief();

revoke all on function stamp_media_purpose_from_brief() from public, anon, authenticated;

-- The house client recruitment briefs attach to. Look up, do not hardcode an id.
-- Create only when an admin needs it and it is missing (fresh environments).
create or replace function aa_house_client_id()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id
    from clients
   where is_internal and lower(name) = 'attract acquisition'
   order by created_at
   limit 1;
  if v_id is not null then
    return v_id;
  end if;
  if not is_admin() then
    raise exception 'Attract Acquisition house client is not configured.';
  end if;
  insert into clients (name, initials, is_internal, sector)
  values ('Attract Acquisition', 'AA', true, 'Agency')
  returning id into v_id;
  return v_id;
end;
$$;

comment on function aa_house_client_id() is
  'The in-house Attract Acquisition client. Recruitment briefs attach here so they never land in a paying client''s campaign.';

-- Seed if missing so production already holding the row is left alone.
insert into clients (name, initials, is_internal, sector)
select 'Attract Acquisition', 'AA', true, 'Agency'
where not exists (
  select 1 from clients
  where is_internal and lower(name) = 'attract acquisition'
);

create or replace function recruitment_brief_must_be_house()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.purpose = 'recruitment' and new.client_id is distinct from aa_house_client_id() then
    raise exception 'Recruitment briefs belong on the Attract Acquisition house client.';
  end if;
  return new;
end;
$$;

drop trigger if exists cb_recruitment_house on client_briefs;
create trigger cb_recruitment_house
  before insert or update on client_briefs
  for each row execute function recruitment_brief_must_be_house();

revoke all on function recruitment_brief_must_be_house() from public, anon, authenticated;

create or replace function compose_recruitment_body(
  p_hook text,
  p_script text,
  p_call_to_action text,
  p_apply_url text,
  p_compensation_text text,
  p_visual_direction text,
  p_premise text
)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  parts text[] := '{}';
begin
  if nullif(trim(p_hook), '') is not null then
    parts := parts || ('## Hook' || E'\n\n' || trim(p_hook));
  end if;
  if nullif(trim(p_premise), '') is not null then
    parts := parts || ('## Premise' || E'\n\n' || trim(p_premise));
  end if;
  if nullif(trim(p_script), '') is not null then
    parts := parts || ('## Primary text' || E'\n\n' || trim(p_script));
  end if;
  if nullif(trim(p_call_to_action), '') is not null then
    parts := parts || ('## Call to action' || E'\n\n' || trim(p_call_to_action));
  end if;
  if nullif(trim(p_apply_url), '') is not null then
    parts := parts || ('## Apply' || E'\n\n' || trim(p_apply_url));
  end if;
  if nullif(trim(p_compensation_text), '') is not null then
    parts := parts || ('## Compensation' || E'\n\n' || trim(p_compensation_text));
  end if;
  if nullif(trim(p_visual_direction), '') is not null then
    parts := parts || ('## Visual direction' || E'\n\n' || trim(p_visual_direction));
  end if;
  parts := parts || ('## Channel' || E'\n\n' || 'Meta static');
  return array_to_string(parts, E'\n\n');
end;
$$;

revoke all on function compose_recruitment_body(text, text, text, text, text, text, text)
  from public, anon, authenticated;

create or replace function create_recruitment_brief(
  p_role recruitment_role,
  p_title text,
  p_hook text,
  p_script text,
  p_call_to_action text,
  p_apply_url text,
  p_visual_direction text default null,
  p_compensation_text text default null,
  p_premise text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client uuid;
  v_id uuid;
  v_url text;
  v_comp text;
begin
  if not is_admin() then
    raise exception 'Only an admin can draft a recruitment brief.';
  end if;
  if p_role is null then
    raise exception 'Recruitment role must be editor, smm or avatar.';
  end if;
  if nullif(trim(p_title), '') is null then
    raise exception 'A recruitment brief needs a title.';
  end if;
  if nullif(trim(p_hook), '') is null then
    raise exception 'A recruitment brief needs a headline.';
  end if;
  if nullif(trim(p_script), '') is null then
    raise exception 'A recruitment brief needs primary text.';
  end if;
  if nullif(trim(p_call_to_action), '') is null then
    raise exception 'A recruitment brief needs a call to action.';
  end if;
  v_url := trim(p_apply_url);
  if v_url is null or v_url !~* '^https://' then
    raise exception 'Apply URL must be an https URL.';
  end if;
  v_comp := nullif(trim(coalesce(p_compensation_text, '')), '');

  v_client := aa_house_client_id();

  insert into client_briefs (
    client_id, title, body, media_type, status, purpose, recruitment_role,
    apply_url, compensation_text, hook, premise, script, call_to_action,
    visual_direction, channel_intent
  ) values (
    v_client,
    trim(p_title),
    compose_recruitment_body(
      p_hook, p_script, p_call_to_action, v_url, v_comp,
      p_visual_direction, p_premise
    ),
    'image',
    'draft',
    'recruitment',
    p_role,
    v_url,
    v_comp,
    trim(p_hook),
    nullif(trim(coalesce(p_premise, '')), ''),
    trim(p_script),
    trim(p_call_to_action),
    nullif(trim(coalesce(p_visual_direction, '')), ''),
    'Meta static'
  ) returning id into v_id;

  return v_id;
end;
$$;

comment on function create_recruitment_brief(recruitment_role, text, text, text, text, text, text, text, text) is
  'Admin-only. Drafts a Meta-static hiring brief on the Attract Acquisition house client, tagged purpose=recruitment.';

create or replace function approve_recruitment_brief(p_brief_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brief client_briefs;
begin
  if not is_admin() then
    raise exception 'Only an admin can approve a recruitment brief.';
  end if;

  select * into v_brief from client_briefs where id = p_brief_id for update;
  if not found then
    raise exception 'That brief does not exist.';
  end if;
  if v_brief.purpose <> 'recruitment' then
    raise exception 'That is not a recruitment brief.';
  end if;
  if v_brief.status <> 'draft' then
    raise exception 'Only a draft recruitment brief can be approved.';
  end if;
  if v_brief.apply_url is null or v_brief.apply_url !~* '^https://' then
    raise exception 'Approve requires an https apply URL.';
  end if;
  if v_brief.recruitment_role is null then
    raise exception 'Approve requires a recruitment role.';
  end if;

  update client_briefs set status = 'approved' where id = p_brief_id;
end;
$$;

comment on function approve_recruitment_brief(uuid) is
  'Admin-only gate before AI generation. Does not enqueue a build.';

-- Reuses public.build_brief_with_ai (mig 43): generation + render +
-- agent_jobs.params.render_id. Wrapper only adds the recruitment gates.
create or replace function generate_recruitment_ad(
  p_brief_id uuid,
  p_quality text default 'medium',
  p_size text default '1024x1536'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brief client_briefs;
  v_gen uuid;
  v_render uuid;
  v_job uuid;
begin
  if not is_admin() then
    raise exception 'Only an admin can generate a recruitment ad.';
  end if;

  select * into v_brief from client_briefs where id = p_brief_id for update;
  if not found then
    raise exception 'That brief does not exist.';
  end if;
  if v_brief.purpose <> 'recruitment' then
    raise exception 'That is not a recruitment brief.';
  end if;
  if v_brief.status <> 'approved' then
    raise exception 'Approve the recruitment brief before generating.';
  end if;
  if v_brief.media_type <> 'image' then
    raise exception 'Recruitment ads are Meta static (image) only.';
  end if;

  update client_briefs
     set production_method = 'ai'
   where id = p_brief_id;

  v_gen := build_brief_with_ai(p_brief_id, p_quality, p_size, null);

  select r.id, r.job_id into v_render, v_job
    from creative_renders r
   where r.generation_id = v_gen
   order by r.created_at desc
   limit 1;

  if v_render is null then
    raise exception 'Generation did not create a render — creative_build cannot run.';
  end if;

  return jsonb_build_object(
    'generation_id', v_gen,
    'render_id', v_render,
    'job_id', v_job
  );
end;
$$;

comment on function generate_recruitment_ad(uuid, text, text) is
  'Admin-only. Calls build_brief_with_ai so creative_build receives params.render_id (mig-93 shape).';

revoke all on function aa_house_client_id() from public, anon;
revoke all on function create_recruitment_brief(recruitment_role, text, text, text, text, text, text, text, text) from public, anon;
revoke all on function approve_recruitment_brief(uuid) from public, anon;
revoke all on function generate_recruitment_ad(uuid, text, text) from public, anon;

grant execute on function aa_house_client_id() to authenticated, service_role;
grant execute on function create_recruitment_brief(recruitment_role, text, text, text, text, text, text, text, text) to authenticated, service_role;
grant execute on function approve_recruitment_brief(uuid) to authenticated, service_role;
grant execute on function generate_recruitment_ad(uuid, text, text) to authenticated, service_role;

commit;

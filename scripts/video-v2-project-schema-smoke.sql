-- Disposable rollback fixture for the additive video project schema.
begin;
insert into public.clients(id, name, initials) values
  ('f1111111-1111-4111-8111-111111111111', 'Video fixture A', 'VA'),
  ('f2222222-2222-4222-8222-222222222222', 'Video fixture B', 'VB');
insert into auth.users(id, instance_id, aud, role, email,
  encrypted_password, created_at, updated_at)
values ('f4444444-4444-4444-8444-444444444444',
  '00000000-0000-0000-0000-000000000000', 'authenticated',
  'authenticated', 'video-schema-client@example.invalid', '', now(), now());
insert into public.profiles(id, role, email)
values ('f4444444-4444-4444-8444-444444444444',
  'client', 'video-schema-client@example.invalid');
insert into public.client_users(client_id, user_id)
values ('f1111111-1111-4111-8111-111111111111',
  'f4444444-4444-4444-8444-444444444444');

insert into public.video_projects(id, client_id, idea, aspects)
values ('f3333333-3333-4333-8333-333333333333',
  'f1111111-1111-4111-8111-111111111111',
  'Show how a specific service solves a real customer problem.',
  array['16:9', '9:16']);
insert into public.video_scenes(project_id, client_id, position, scene_key,
  component, props, narration)
values ('f3333333-3333-4333-8333-333333333333',
  'f1111111-1111-4111-8111-111111111111', 1, 's01', 'TitleCard',
  '{"title":"A clearer route"}', 'Here is a clearer route to growth.');
insert into public.video_project_costs(project_id, client_id, stage,
  provider, units, unit, usd)
values ('f3333333-3333-4333-8333-333333333333',
  'f1111111-1111-4111-8111-111111111111', 'script', 'fixture', 1, 'request', 0);
insert into public.video_projects(id, client_id, idea)
values ('f5555555-5555-4555-8555-555555555555',
  'f2222222-2222-4222-8222-222222222222',
  'A separate client video must stay outside this user scope.');
insert into public.video_scenes(project_id, client_id, position, scene_key,
  component, props, narration)
values ('f5555555-5555-4555-8555-555555555555',
  'f2222222-2222-4222-8222-222222222222', 1, 's01', 'TitleCard',
  '{"title":"Other client"}', 'Only the other client may read this.');
insert into public.video_project_costs(project_id, client_id, stage,
  provider, units, unit, usd)
values ('f5555555-5555-4555-8555-555555555555',
  'f2222222-2222-4222-8222-222222222222', 'script', 'fixture', 1, 'request', 0);

do $checks$
begin
  if not public.video_aspects_valid_v1(array['16:9', '1:1'])
    or public.video_aspects_valid_v1(array['16:9', '16:9'])
    or public.video_aspects_valid_v1(array['4:3']) then
    raise exception 'Aspect validation failed';
  end if;
  begin
    insert into public.video_scenes(project_id, client_id, position,
      scene_key, component, props, narration)
    values ('f3333333-3333-4333-8333-333333333333',
      'f2222222-2222-4222-8222-222222222222', 2, 's02',
      'SectionCard', '{}', 'This must remain outside the other client.');
    raise exception 'Cross-client scene was accepted';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.video_project_costs(project_id, client_id, stage,
      provider, units, unit, usd)
    values ('f3333333-3333-4333-8333-333333333333',
      'f2222222-2222-4222-8222-222222222222', 'render', 'fixture', 1, 'minute', 1);
    raise exception 'Cross-client cost was accepted';
  exception when foreign_key_violation then null; end;
  if has_table_privilege('authenticated', 'public.video_projects', 'INSERT')
    or has_table_privilege('authenticated', 'public.video_scenes', 'UPDATE')
    or has_table_privilege('authenticated', 'public.video_project_costs', 'DELETE')
    or not has_table_privilege('authenticated', 'public.video_projects', 'SELECT') then
    raise exception 'Video table grants are incorrect';
  end if;
  if not (select relrowsecurity from pg_class
    where oid='public.video_projects'::regclass)
    or not (select relrowsecurity from pg_class
      where oid='public.video_scenes'::regclass)
    or not (select relrowsecurity from pg_class
      where oid='public.video_project_costs'::regclass) then
    raise exception 'Video table RLS is disabled';
  end if;
  if to_regclass('public.motion_design_projects') is null
    or to_regclass('public.motion_render_candidates') is null then
    raise exception 'Legacy Motion Design review history was removed';
  end if;
end $checks$;

set local role authenticated;
select set_config('request.jwt.claim.sub',
  'f4444444-4444-4444-8444-444444444444', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
do $rls$
begin
  if (select count(*) from public.video_projects) <> 1
    or (select count(*) from public.video_scenes) <> 1
    or (select count(*) from public.video_project_costs) <> 1 then
    raise exception 'Client A could not read its video rows';
  end if;
  begin
    insert into public.video_projects(client_id, idea)
    values ('f1111111-1111-4111-8111-111111111111',
      'An authenticated browser must not create a project directly.');
    raise exception 'Authenticated role could write directly';
  exception when insufficient_privilege then null; end;
end $rls$;
rollback;

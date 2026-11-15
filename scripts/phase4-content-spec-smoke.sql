-- Rollback-only proof that exact content shape is reviewable and versioned.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','campaign-spec-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','campaign-spec-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Campaign spec fixture','CS');
insert into public.client_campaigns(id,client_id,name,brief,acquisition_mode,runs_organic,runs_paid,
  paid_platform,content_count,organic_content_count,paid_content_count,built_at)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Mixed route','Test reviewed formats',
  'both',true,true,'meta',2,1,1,now());
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
do $checks$
declare cid uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  first_id uuid; next_id uuid; first_hash text; next_hash text;
  first_spec jsonb:='[{"route":"organic","platform":"instagram","media_type":"video","content_format":"reel"},
    {"route":"paid","platform":"facebook","media_type":"image","content_format":"carousel"}]'::jsonb;
begin
  begin
    perform public.approve_campaign_plan_v6(cid);
    raise exception 'Plan without a content specification was approved';
  exception when check_violation then null; end;
  begin
    perform public.set_campaign_content_spec_v7(cid,
      '[{"route":"organic","platform":"instagram","media_type":"video","content_format":"reel"},
        {"route":"paid","platform":"facebook","media_type":"image"}]'::jsonb);
    raise exception 'Incomplete content specification was accepted';
  exception when check_violation then null; end;
  first_id:=public.set_campaign_content_spec_v7(cid,first_spec);
  if first_id is null or first_id<>public.set_campaign_content_spec_v7(cid,first_spec) then
    raise exception 'Exact retry did not reuse the content specification'; end if;
  perform public.approve_campaign_plan_v6(cid);
  select plan_approved_fingerprint into first_hash from public.client_campaigns where id=cid;
  if first_hash is null then raise exception 'Human approval did not bind the plan'; end if;
  next_id:=public.set_campaign_content_spec_v7(cid,
    '[{"route":"organic","platform":"instagram","media_type":"image","content_format":"story"},
      {"route":"paid","platform":"facebook","media_type":"image","content_format":"carousel"}]'::jsonb);
  select public.campaign_plan_fingerprint(c) into next_hash from public.client_campaigns c where c.id=cid;
  if next_id=first_id or (select plan_approved_at from public.client_campaigns where id=cid) is not null
    or first_hash=next_hash
    then raise exception 'Changing the content shape retained the old approval'; end if;
end $checks$;
rollback;

-- Rollback-only proof that human plan approval selects its exact saved ideas
-- and changing the words revokes brief authority.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','plan-idea-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','plan-idea-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Plan idea fixture','PI');
insert into public.client_campaigns(id,client_id,name,brief,acquisition_mode,runs_organic,runs_paid,
  content_count,organic_content_count,paid_content_count,built_at)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Reviewed campaign','Two exact pieces',
  'organic',true,false,2,2,0,now());
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select public.set_campaign_content_spec_v7('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '[{"route":"organic","platform":"instagram","media_type":"image","content_format":"single"},
    {"route":"organic","platform":"instagram","media_type":"video","content_format":"reel"}]'::jsonb);
insert into public.client_ideas(client_id,campaign_id,campaign_position,title,body,
  source_question,media_type,content_format,target_platform,source,status)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',1,'Exact buyer angle',
  'Answer the buyer concern with a concrete service promise and CTA.',
  'What will the service change?','image','single','instagram','auto','draft'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',2,'Illustrative reel',
  'Show an example.', 'What could it look like?','video','reel','instagram','auto','draft');
update public.client_campaigns set content_ideas_generated_at=now()
  where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
select public.bind_campaign_planned_ideas_v7('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);

do $checks$
declare cid uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  idea_id uuid; reel_id uuid; job_id uuid; first_job uuid;
begin
  select id into idea_id from public.client_ideas where campaign_id=cid and campaign_position=1;
  select id into reel_id from public.client_ideas where campaign_id=cid and campaign_position=2;
  if public.campaign_planned_idea_selection_current_v7(idea_id) then
    raise exception 'An unapproved plan selected an idea'; end if;
  perform public.approve_campaign_plan_v6(cid);
  if (select status from public.client_ideas where id=idea_id)<>'approved'
    or not public.campaign_planned_idea_selection_current_v7(idea_id) then
    raise exception 'Human plan approval did not select the exact idea'; end if;
  -- Use the operator RPC for the first piece, then let the real filing trigger
  -- archive it. The same review must still authorize the second piece.
  first_job:=public.approve_idea_and_generate_brief(idea_id);
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  insert into public.client_briefs(client_id,source_idea_id,job_id,title)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',idea_id,first_job,'Exact saved brief');
  if not exists (select 1 from public.client_ideas where id=idea_id and archived_at is not null)
    or public.campaign_planned_idea_selection_current_v7(idea_id)
    or not public.campaign_planned_idea_selection_current_v7(reel_id) then
    raise exception 'Filing the first brief must archive its own idea and retain the sibling selection'; end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  job_id:=public.approve_idea_and_generate_brief(reel_id);
  if public.approve_idea_and_generate_brief(reel_id) is distinct from job_id then
    raise exception 'Retry created another brief job'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  -- An edited sibling, including an already-filed one, still invalidates the batch.
  -- The queued reel's output gate must also see that change.
  if not public.brief_job_selection_current_v6(job_id) then
    raise exception 'Selected planned idea did not authorize its brief'; end if;
  update public.client_ideas set body='A changed buyer promise after review.' where id=idea_id;
  if public.campaign_planned_idea_selection_current_v7(reel_id)
    or public.brief_job_selection_current_v6(job_id) then
    raise exception 'Changed idea words retained the old plan selection'; end if;
  update public.client_ideas
    set body='Answer the buyer concern with a concrete service promise and CTA.'
    where id=idea_id;
  if public.campaign_planned_idea_selection_current_v7(reel_id) then
    raise exception 'Reverted idea words revived the old plan selection'; end if;
  begin
    perform public.enqueue_agent_job_internal('brief',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','client_ideas',reel_id,null);
    raise exception 'A changed idea queued another brief';
  exception when insufficient_privilege then null; end;
  -- Previously invalidated plans get an explicit review, never a data backfill.
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal2"}',true);
  perform public.approve_campaign_plan_v6(cid);
  if not public.campaign_planned_idea_selection_current_v7(reel_id) then
    raise exception 'A fresh review did not recover the still-current reel'; end if;
  update public.client_ideas set archived_at=now() where id=reel_id;
  if public.campaign_planned_ideas_match_spec_v7(cid) then
    raise exception 'A manual archive without a filed brief passed the batch gate'; end if;
end $checks$;
rollback;

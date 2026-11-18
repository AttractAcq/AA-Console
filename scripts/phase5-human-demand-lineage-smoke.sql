-- Exact human assignment binding survives rework and refuses a shared-brief guess.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values
 ('d9999999-9999-4999-8999-999999999991','00000000-0000-0000-0000-000000000000','authenticated','authenticated','demand-admin@example.invalid','',now(),now()),
 ('d9999999-9999-4999-8999-999999999992','00000000-0000-0000-0000-000000000000','authenticated','authenticated','demand-outsider@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
 ('d9999999-9999-4999-8999-999999999991','admin','demand-admin@example.invalid'),
 ('d9999999-9999-4999-8999-999999999992','client','demand-outsider@example.invalid');
do $checks$
declare
  c public.clients%rowtype;
  other_client public.clients%rowtype;
  campaign public.client_campaigns%rowtype;
  pillar public.client_content_pillars%rowtype;
  brief public.client_briefs%rowtype;
  other_brief public.client_briefs%rowtype;
  maker public.team_members%rowtype;
  run_one public.workflow_runs%rowtype;
  run_two public.workflow_runs%rowtype;
  step_one public.workflow_steps%rowtype;
  step_two public.workflow_steps%rowtype;
  package_one public.daily_packages%rowtype;
  package_two public.daily_packages%rowtype;
  item_one public.daily_package_items%rowtype;
  item_two public.daily_package_items%rowtype;
  assignment public.job_assignments%rowtype;
  unbound_assignment public.job_assignments%rowtype;
  asset_one uuid;
  asset_two uuid;
  unbound_asset uuid;
  refused boolean;
  n public.production_demand_counts_v8%rowtype;
begin
  insert into public.clients(id,name,initials)
    values('d9999999-9999-4999-8999-999999999993','Human demand fixture','HD') returning * into c;
  insert into public.clients(name,initials)
    values('Other human demand client','OC') returning * into other_client;
  insert into public.client_campaigns(client_id,name,brief,built_at)
    values(c.id,'Human demand campaign','Fixture',now()) returning * into campaign;
  insert into public.client_content_pillars
    (client_id,slug,name,premise,belongs,does_not_belong)
    values(c.id,'human-fixture','Human fixture','Premise','Belongs','Other')
    returning * into pillar;
  insert into public.client_briefs(client_id,title,media_type,target_platform)
    values(c.id,'Shared brief','image','instagram') returning * into brief;
  insert into public.client_briefs(client_id,title,media_type,target_platform)
    values(c.id,'Wrong brief','image','instagram') returning * into other_brief;
  insert into public.team_members(category,name,initials)
    values('editors','Human fixture editor','HE') returning * into maker;
  refused:=false;
  begin
    insert into public.job_assignments(member_id,client_id,brief_id,title)
      values(maker.id,other_client.id,brief.id,'Wrong client brief');
  exception when check_violation then
    refused:=sqlerrm='Assignment brief must belong to the assignment client.';
  end;
  if not refused then raise exception 'General assignment accepted another client brief'; end if;
  insert into public.workflow_runs
    (client_id,campaign_id,kind,workflow_version,idempotency_key,input_snapshot,deadline_at)
    values(c.id,campaign.id,'daily_content_package','fixture','human-one','{}',now()+interval '1 day')
    returning * into run_one;
  insert into public.workflow_runs
    (client_id,campaign_id,kind,workflow_version,idempotency_key,input_snapshot,deadline_at)
    values(c.id,campaign.id,'daily_content_package','fixture','human-two','{}',now()+interval '1 day')
    returning * into run_two;
  insert into public.workflow_steps(run_id,step_key,agent_key,input_table,input_id)
    values(run_one.id,'static_a_create','creative_build','client_briefs',brief.id)
    returning * into step_one;
  insert into public.workflow_steps(run_id,step_key,agent_key,input_table,input_id)
    values(run_two.id,'static_a_create','creative_build','client_briefs',brief.id)
    returning * into step_two;
  insert into public.daily_packages(run_id,client_id,package_day,cutoff_at,platform,story_media_type)
    values(run_one.id,c.id,current_date,now()+interval '1 hour','instagram','image')
    returning * into package_one;
  insert into public.daily_packages(run_id,client_id,package_day,cutoff_at,platform,story_media_type)
    values(run_two.id,c.id,current_date+1,now()+interval '1 day','instagram','image')
    returning * into package_two;
  insert into public.daily_package_items
    (package_id,role,content_format,media_type,campaign_id,pillar_id,final_step_id)
    values(package_one.id,'static_a','single','image',campaign.id,pillar.id,step_one.id)
    returning * into item_one;
  insert into public.daily_package_items
    (package_id,role,content_format,media_type,campaign_id,pillar_id,final_step_id)
    values(package_two.id,'static_a','single','image',campaign.id,pillar.id,step_two.id)
    returning * into item_two;
  if (select count(*) from public.assignable_production_demands_v7
      where client_id=c.id and brief_id=brief.id)<>2
    or exists(select 1 from public.assignable_production_demands_v7
      where client_id=c.id and brief_id=other_brief.id) then
    raise exception 'Brief-filtered demand discovery leaked or omitted a run';
  end if;
  perform set_config('request.jwt.claim.role','authenticated',true);
  refused:=false;
  begin
    perform public.create_demand_assignment_v7(maker.id,c.id,brief.id,
      'daily',item_one.id,'No human admin');
  exception when sqlstate '42501' then refused:=true; end;
  if not refused then raise exception 'Nonadmin assignment was accepted'; end if;
  perform set_config('request.jwt.claim.role','service_role',true);
  refused:=false;
  begin
    perform public.create_demand_assignment_v7(maker.id,c.id,other_brief.id,
      'daily',item_one.id,'Wrong brief');
  exception when others then refused:=true; end;
  if not refused then raise exception 'Wrong brief was bound to demand'; end if;
  select * into assignment from public.create_demand_assignment_v7(
    maker.id,c.id,brief.id,'daily',item_one.id,'Exact human delivery');
  refused:=false;
  begin
    update public.client_briefs set client_id=other_client.id where id=brief.id;
  exception when check_violation then
    refused:=sqlerrm='An assigned brief cannot move to another client.';
  end;
  if not refused then raise exception 'Assigned brief moved to another client'; end if;
  insert into public.client_media_assets
    (client_id,brief_id,member_id,media_type,storage_path)
    values(c.id,brief.id,maker.id,'image',c.id::text||'/human-one.png')
    returning id into asset_one;
  perform public.deliver_assignment(assignment.id,asset_one);
  perform public.advance_assignment(assignment.id,'rework','review','Revise it');
  insert into public.client_media_assets
    (client_id,brief_id,member_id,media_type,storage_path)
    values(c.id,brief.id,maker.id,'image',c.id::text||'/human-two.png')
    returning id into asset_two;
  perform public.deliver_assignment(assignment.id,asset_two);
  select * into n from public.production_demand_counts_v8 where demand_id=item_one.id;
  if n.attempts<>2 or n.produced<>2 or n.revised<>1
    or n.human_approved<>0 then
    raise exception 'Exact human history not counted: %',row_to_json(n);
  end if;
  if not exists (select 1 from public.production_attempt_timing_v8 t
      where t.demand_id=item_one.id and t.attempt_kind='human_delivery'
        and t.timing_basis='assignment to delivery'
        and t.started_at<=t.finished_at) then
    raise exception 'Human assignment-to-delivery timing missing';
  end if;
  select * into n from public.production_demand_counts_v8 where demand_id=item_two.id;
  if n.attempts<>0 then
    raise exception 'Shared brief leaked delivery to another demand: %',row_to_json(n);
  end if;
  insert into public.job_assignments(member_id,client_id,brief_id,title)
    values(maker.id,c.id,brief.id,'Unbound human work')
    returning * into unbound_assignment;
  insert into public.client_media_assets
    (client_id,brief_id,member_id,media_type,storage_path)
    values(c.id,brief.id,maker.id,'image',c.id::text||'/unbound.png')
    returning id into unbound_asset;
  perform public.deliver_assignment(unbound_assignment.id,unbound_asset);
  select * into n from public.production_demand_counts_v8 where demand_id=item_one.id;
  if n.attempts<>2 then
    raise exception 'An unbound delivery was guessed from its brief';
  end if;
  refused:=false;
  begin
    update public.job_assignments set brief_id=other_brief.id where id=assignment.id;
  exception when others then refused:=true; end;
  if not refused then raise exception 'Bound assignment was retargeted'; end if;
  refused:=false;
  begin
    update public.assignment_demand_bindings_v7 set demand_id=item_two.id
      where assignment_id=assignment.id;
  exception when others then refused:=true; end;
  if not refused then raise exception 'Demand binding was rewritten'; end if;
  update public.client_media_assets set review_status='approved' where id=asset_two;
  select * into n from public.production_demand_counts_v8 where demand_id=item_one.id;
  if n.human_approved<>1 or n.workflow_accepted<>0 then
    raise exception 'Review and workflow QA were conflated: %',row_to_json(n);
  end if;
end $checks$;
set local role authenticated;
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claim.sub','d9999999-9999-4999-8999-999999999991',true);
do $$ begin
  if (select count(*) from public.assignable_production_demands_v7
      where client_id='d9999999-9999-4999-8999-999999999993')<>2 then
    raise exception 'Signed-in admin cannot discover the exact requests';
  end if;
end $$;
select set_config('request.jwt.claim.sub','d9999999-9999-4999-8999-999999999992',true);
do $$ begin
  if exists(select 1 from public.assignable_production_demands_v7
      where client_id='d9999999-9999-4999-8999-999999999993') then
    raise exception 'Unrelated client can discover another client demand';
  end if;
end $$;
rollback;

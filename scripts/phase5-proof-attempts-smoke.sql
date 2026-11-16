-- A proof request counts only derivatives of its exact idea and brief.
begin;
do $checks$
declare
  c public.clients%rowtype;
  source public.client_proof_assets%rowtype;
  idea public.client_ideas%rowtype;
  brief public.client_briefs%rowtype;
  asset public.client_media_assets%rowtype;
  maker public.team_members%rowtype;
  assignment public.job_assignments%rowtype;
  manual_one uuid;
  manual_two uuid;
  refused boolean := false;
  v_request_id uuid := gen_random_uuid();
  v_other_request_id uuid := gen_random_uuid();
  generation_id uuid;
  counts public.proof_production_counts_v7%rowtype;
begin
  insert into public.clients(name,initials)
    values('Proof attempt fixture','PA') returning * into c;
  insert into public.client_proof_assets
    (client_id,media_type,title,body)
    values(c.id,'text','Customer evidence','The customer''s own account')
    returning * into source;
  insert into public.client_ideas
    (client_id,title,media_type,source,proof_id)
    values(c.id,'Proof derivative','image','proof',source.id)
    returning * into idea;
  insert into public.proof_production_requests
    (id,client_id,source_proof_id,idea_id,direction,destination)
    values(v_request_id,c.id,source.id,idea.id,'Make a quote graphic',
      'Organic Social Media');
  insert into public.client_briefs
    (client_id,source_idea_id,proof_asset_id,title,media_type)
    values(c.id,idea.id,source.id,'Quote graphic','image')
    returning * into brief;
  insert into public.client_media_assets
    (client_id,brief_id,media_type,storage_path)
    values(c.id,brief.id,'image',c.id::text||'/proof-fixture.png')
    returning * into asset;
  insert into public.creative_generations(client_id,brief_id,media_type)
    values(c.id,brief.id,'image') returning id into generation_id;
  insert into public.creative_renders
    (generation_id,client_id,status,asset_id,cost_usd)
    values(generation_id,c.id,'done',asset.id,0.12);
  insert into public.creative_renders
    (generation_id,client_id,status,error,cost_usd)
    values(generation_id,c.id,'failed','Fixture rejection',0.04);
  select * into counts from public.proof_production_counts_v7
    where proof_production_counts_v7.request_id=v_request_id;
  if counts.attempts<>2 or counts.produced<>1 or counts.rejected<>1
    or counts.awaiting_review<>1 or counts.human_approved<>0
    or counts.render_cost_usd<>0.16 then
    raise exception 'Proof attempt counts are wrong: %',row_to_json(counts);
  end if;
  update public.client_media_assets set review_status='approved' where id=asset.id;
  select * into counts from public.proof_production_counts_v7
    where proof_production_counts_v7.request_id=v_request_id;
  if counts.awaiting_review<>0 or counts.human_approved<>1 then
    raise exception 'Human approval did not change exact proof request: %',row_to_json(counts);
  end if;
  insert into public.client_ideas
    (client_id,title,media_type,source,proof_id)
    values(c.id,'Other derivative','image','proof',source.id)
    returning * into idea;
  insert into public.proof_production_requests
    (id,client_id,source_proof_id,idea_id,direction,destination)
    values(v_other_request_id,c.id,source.id,idea.id,'Make another graphic',
      'Organic Social Media');
  select * into counts from public.proof_production_counts_v7
    where proof_production_counts_v7.request_id=v_other_request_id;
  if counts.attempts<>0 or counts.produced<>0 or counts.human_approved<>0 then
    raise exception 'Another proof request inherited unrelated attempts: %',row_to_json(counts);
  end if;
  insert into public.team_members(category,name,initials)
    values('editors','Fixture editor','FE') returning * into maker;
  insert into public.job_assignments(member_id,client_id,brief_id,title)
    values(maker.id,c.id,brief.id,'Produce proof graphic') returning * into assignment;
  insert into public.client_media_assets
    (client_id,brief_id,member_id,media_type,storage_path)
    values(c.id,brief.id,maker.id,'image',c.id::text||'/manual-one.png')
    returning id into manual_one;
  perform public.deliver_assignment(assignment.id,manual_one);
  perform public.advance_assignment(assignment.id,'rework','review','Try another composition');
  insert into public.client_media_assets
    (client_id,brief_id,member_id,media_type,storage_path)
    values(c.id,brief.id,maker.id,'image',c.id::text||'/manual-two.png')
    returning id into manual_two;
  perform public.deliver_assignment(assignment.id,manual_two);
  if (select count(*) from public.assignment_deliveries_v7
      where assignment_id=assignment.id)<>2 then
    raise exception 'Rework replaced an earlier human delivery';
  end if;
  begin
    update public.assignment_deliveries_v7 set asset_id=manual_two
      where assignment_id=assignment.id and asset_id=manual_one;
  exception when others then refused:=true; end;
  if not refused then raise exception 'Assignment delivery history was mutable'; end if;
  select * into counts from public.proof_production_counts_v7
    where proof_production_counts_v7.request_id=v_request_id;
  if counts.attempts<>4 or counts.produced<>3 or counts.awaiting_review<>2
    or counts.human_approved<>1 then
    raise exception 'Human deliveries did not retain proof lineage: %',row_to_json(counts);
  end if;
end $checks$;
rollback;

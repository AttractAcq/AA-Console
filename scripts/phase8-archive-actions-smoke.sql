begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('a5555555-5555-4555-8555-555555555555','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','archive-admin@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('a5555555-5555-4555-8555-555555555555','admin','archive-admin@example.invalid');
insert into public.clients(id,name,initials) values
  ('b5555555-5555-4555-8555-555555555555','Archive fixture','AF'),
  ('c5555555-5555-4555-8555-555555555555','Other archive fixture','OA');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $checks$
declare cid uuid:='b5555555-5555-4555-8555-555555555555';
  other_id uuid:='c5555555-5555-4555-8555-555555555555';
  names text[]:=array['client_pages','client_campaigns','client_sales_agents',
    'market_opportunities','client_agent_records','lead_magnets'];
  ids uuid[]:=array[]::uuid[]; rec_id uuid; i integer; refused boolean:=false;
begin
  insert into public.client_pages(client_id,page_type,title)
    values(cid,'landing','Archive page') returning id into rec_id; ids:=array_append(ids,rec_id);
  insert into public.client_campaigns(client_id,name,brief)
    values(cid,'Archive campaign','Archive fixture brief') returning id into rec_id;
    ids:=array_append(ids,rec_id);
  insert into public.client_sales_agents(client_id,name,purpose)
    values(cid,'Archive agent','Capture leads') returning id into rec_id;
    ids:=array_append(ids,rec_id);
  insert into public.market_opportunities(client_id,name,micro_market,buying_situation,idempotency_key)
    values(cid,'Archive opportunity','Homeowners','Planning a renovation','archive-fixture-1')
    returning id into rec_id; ids:=array_append(ids,rec_id);
  insert into public.client_agent_records(client_id,domain,item_key,title,body)
    values(cid,'icp','archive-fixture','Archive ICP','Original model body')
    returning id into rec_id; ids:=array_append(ids,rec_id);
  insert into public.lead_magnets(client_id,name,objective,format)
    values(cid,'Archive magnet','Capture interested leads','pdf_guide')
    returning id into rec_id; ids:=array_append(ids,rec_id);
  perform set_config('request.jwt.claim.role','authenticated',true);
  perform set_config('request.jwt.claim.sub','a5555555-5555-4555-8555-555555555555',true);
  perform set_config('request.jwt.claims',
    '{"sub":"a5555555-5555-4555-8555-555555555555","role":"authenticated","aal":"aal2"}',true);
  for i in 1..array_length(names,1) loop
    perform public.set_client_archive_v8(cid,names[i],ids[i],true);
    execute format('select id from public.%I where id=$1 and archived_at is not null',names[i])
      into rec_id using ids[i];
    if rec_id is distinct from ids[i] then raise exception 'Archive stamp missing for %',names[i]; end if;
    begin perform public.set_client_archive_v8(cid,names[i],ids[i],true);
    exception when check_violation then refused:=true; end;
    if not refused then raise exception 'Repeated archive was accepted for %',names[i]; end if;
    refused:=false;
    perform public.set_client_archive_v8(cid,names[i],ids[i],false);
    execute format('select id from public.%I where id=$1 and archived_at is null',names[i])
      into rec_id using ids[i];
    if rec_id is distinct from ids[i] then raise exception 'Restore failed for %',names[i]; end if;
    if (select count(*) from public.archive_decisions_v8 d
      where d.client_id=cid and d.table_name=names[i] and d.record_id=ids[i])<>2 then
      raise exception 'Archive audit missing for %',names[i]; end if;
  end loop;
  -- The active model key is reusable only after its previous version is
  -- archived. Restoring the old version must refuse a duplicate active key.
  perform public.set_client_archive_v8(cid,'client_agent_records',ids[5],true);
  insert into public.client_agent_records(client_id,domain,item_key,title,body)
    values(cid,'icp','archive-fixture','Replacement ICP','New active body')
    returning id into rec_id;
  if (select body from public.client_agent_records where id=ids[5])<>'Original model body'
    or (select count(*) from public.client_agent_records where client_id=cid
      and domain='icp' and item_key='archive-fixture')<>2 then
    raise exception 'Archived model version was overwritten'; end if;
  begin perform public.set_client_archive_v8(cid,'client_agent_records',ids[5],false);
  exception when unique_violation then refused:=true; end;
  if not refused then raise exception 'Conflicting model restore was accepted'; end if;
  refused:=false;
  begin perform public.set_client_archive_v8(other_id,'lead_magnets',ids[6],true);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Cross-client archive was accepted'; end if;
  refused:=false;
  begin perform public.set_client_archive_v8(cid,'client_leads',ids[1],true);
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Unknown archive table was accepted'; end if;
  refused:=false;
  perform set_config('request.jwt.claim.sub','f5555555-5555-4555-8555-555555555555',true);
  perform set_config('request.jwt.claims',
    '{"sub":"f5555555-5555-4555-8555-555555555555","role":"authenticated"}',true);
  begin perform public.set_client_archive_v8(cid,'lead_magnets',ids[6],true);
  exception when insufficient_privilege then refused:=true; end;
  if not refused then raise exception 'Unauthorized archive was accepted'; end if;
end $checks$;
rollback;

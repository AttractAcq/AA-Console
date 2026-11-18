-- A shared proof link keeps its original setup after the setup is edited.
begin;
insert into public.clients(id,name,initials) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Capture source fixture','CS'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Other capture fixture','OC');
insert into public.proof_capture_configs(id,client_id,method,name,instructions)
values ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','field_capture',
  'Original setup','Describe the completed job');
insert into public.proof_capture_links(id,client_id,config_id,token_hash,expires_at)
values ('dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc','capture-snapshot-fixture',
  now()+interval '1 day');

do $checks$
declare proof_id uuid; refused boolean:=false;
begin
  if not exists(select 1 from public.proof_capture_links
      where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'
        and config_snapshot_origin='created_with_link'
        and config_snapshot->>'method'='field_capture'
        and config_snapshot->>'name'='Original setup'
        and config_snapshot->>'instructions'='Describe the completed job') then
    raise exception 'New link did not freeze its setup'; end if;
  update public.proof_capture_configs
    set method='guided_interview',name='Changed setup',instructions='Changed text'
    where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  perform set_config('request.jwt.claim.role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role"}',true);
  proof_id:=public.accept_proof_capture_submission('capture-snapshot-fixture',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','Submitter','job-1',
    'A completed job with supporting details',null,null,'customers',
    'Online Reviews','Permission confirmed for internal review');
  if not exists(select 1 from public.client_proof_assets p where p.id=proof_id
      and p.capture_method='field_capture'
      and p.title='Original setup · Submitter'
      and p.usage_rights='not_cleared') then
    raise exception 'Proof submission followed an edited setup'; end if;
  if (select submissions from public.proof_capture_links
      where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd')<>1 then
    raise exception 'Capture submission count was not recorded'; end if;
  begin
    update public.proof_capture_links
      set config_snapshot=jsonb_build_object('method','manual_import')
      where id='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  exception when others then refused:=true; end;
  if not refused then raise exception 'Link source snapshot was rewritten'; end if;
  refused:=false;
  begin
    insert into public.proof_capture_links(client_id,config_id,token_hash,expires_at)
    values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc','wrong-client-capture',
      now()+interval '1 day');
  exception when others then refused:=true; end;
  if not refused then raise exception 'Cross-client capture link was accepted'; end if;
end $checks$;
rollback;

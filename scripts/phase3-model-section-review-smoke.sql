-- Rollback-only proof that generated model sections need dated human review.
begin;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','model-review-admin@example.invalid','',now(),now()),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','model-review-outsider@example.invalid','',now(),now());
insert into public.profiles(id,role,email) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','admin','model-review-admin@example.invalid'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','client','model-review-outsider@example.invalid');
insert into public.clients(id,name,initials)
values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Model review fixture','MR');
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated","aal":"aal1"}',true);

do $checks$
declare v_record_id uuid; review public.model_section_reviews_v7%rowtype;
begin
  insert into public.client_agent_records(client_id,domain,item_key,title,body)
    values('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','offer_strategy',
      'core_offer','Core offer','Garage conversion for homeowners')
    returning id into v_record_id;
  if (select review_state from public.model_section_review_state_v7
    where record_id=v_record_id)<>'missing' then
    raise exception 'Unreviewed model was treated as supported'; end if;
  begin
    perform public.review_model_section_v7(v_record_id,'Interview with owner',current_date+1,
      'supported','');
    raise exception 'Future observation date was accepted';
  exception when check_violation then null; end;
  review := public.review_model_section_v7(v_record_id,'Interview with owner',current_date,
    'supported','Verified against the sales call');
  if review.record_snapshot->>'body'<>'Garage conversion for homeowners'
    or (select review_state from public.model_section_review_state_v7
      where record_id=v_record_id)<>'supported' then
    raise exception 'Exact reviewed model section was not current'; end if;
  update public.client_agent_records set body='Garage conversion for rental owners'
    where id=v_record_id;
  if (select review_state from public.model_section_review_state_v7
    where record_id=v_record_id)<>'stale' then
    raise exception 'Edited model retained its prior review'; end if;
  perform public.review_model_section_v7(v_record_id,'Interview with owner',current_date,
    'unsupported','Rental owner claim is not supported');
  if (select review_state from public.model_section_review_state_v7
    where record_id=v_record_id)<>'unsupported' then
    raise exception 'Unsupported section was presented as usable'; end if;
  perform set_config('request.jwt.claim.sub','cccccccc-cccc-4ccc-8ccc-cccccccccccc',true);
  perform set_config('request.jwt.claims',
    '{"sub":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","role":"authenticated","aal":"aal2"}',true);
  begin
    perform public.review_model_section_v7(v_record_id,'Guess',current_date,'supported','');
    raise exception 'Wrong client reviewed model';
  exception when insufficient_privilege then null; end;
end $checks$;
rollback;

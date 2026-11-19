-- Rollback-only evidence contract for every file of a framed creative.
begin;
insert into public.clients(id,name,initials) values
  ('b1100000-0000-4000-8000-000000000001','Frame evidence fixture','FE');
insert into public.client_media_assets
  (id,client_id,media_type,content_format,title,storage_path,usage_rights)
values ('a1100000-0000-4000-8000-000000000001',
  'b1100000-0000-4000-8000-000000000001','image','carousel','Two frames',
  'frame-evidence/one.png','agency_owned');
insert into public.client_media_frames(id,asset_id,position,storage_path,caption) values
  ('f1100000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000001',1,'frame-evidence/one.png','One'),
  ('f1100000-0000-4000-8000-000000000002','a1100000-0000-4000-8000-000000000001',2,'frame-evidence/two.png','Two');
insert into storage.objects(id,bucket_id,name,version) values
  ('01100000-0000-4000-8000-000000000001','client-media','frame-evidence/one.png','v1'),
  ('01100000-0000-4000-8000-000000000002','client-media','frame-evidence/two.png','v1');
select set_config('request.jwt.claim.role','authenticated',true);
do $denial$
begin
  begin
    perform public.creative_frame_storage_identities_v8('a1100000-0000-4000-8000-000000000001');
    raise exception 'An untrusted caller read frame identity';
  exception when insufficient_privilege then null; end;
end $denial$;
select set_config('request.jwt.claim.role','service_role',true);
do $checks$
declare aid uuid:='a1100000-0000-4000-8000-000000000001';
  first_frame uuid:='f1100000-0000-4000-8000-000000000001';
  second_frame uuid:='f1100000-0000-4000-8000-000000000002';
  snapshot jsonb;
begin
  snapshot:=public.creative_frame_storage_identities_v8(aid);
  if jsonb_array_length(snapshot->'frames')<>2
    or snapshot#>>'{frames,0,storage_path}'<>'frame-evidence/one.png'
    or snapshot#>>'{frames,1,storage_path}'<>'frame-evidence/two.png' then
    raise exception 'Ordered frame identity is incomplete'; end if;
  perform public.attest_creative_frame_bytes_v8(aid,first_frame,'frame-evidence/one.png',
    repeat('a',64),123,'01100000-0000-4000-8000-000000000001','v1',
    (select updated_at from storage.objects where name='frame-evidence/one.png'));
  perform public.attest_creative_frame_bytes_v8(aid,second_frame,'frame-evidence/two.png',
    repeat('b',64),456,'01100000-0000-4000-8000-000000000002','v1',
    (select updated_at from storage.objects where name='frame-evidence/two.png'));
  if (select count(*) from public.creative_frame_bytes_v8 where asset_id=aid)<>2 then
    raise exception 'Per-frame evidence was not recorded'; end if;
  begin
    perform public.attest_creative_frame_bytes_v8(aid,second_frame,'frame-evidence/two.png',
      repeat('c',64),456,'01100000-0000-4000-8000-000000000002','wrong-version',
      (select updated_at from storage.objects where name='frame-evidence/two.png'));
    raise exception 'Stale Storage version was accepted';
  exception when check_violation then null; end;
  update storage.objects set version='v2' where name='frame-evidence/two.png';
  if (select count(*) from public.creative_frame_bytes_v8 where asset_id=aid)<>1 then
    raise exception 'Storage replacement did not invalidate the exact frame'; end if;
  update public.client_media_frames set caption='Revised' where id=first_frame;
  if exists(select 1 from public.creative_frame_bytes_v8 where asset_id=aid) then
    raise exception 'Frame metadata change left byte evidence current'; end if;
end $checks$;
rollback;

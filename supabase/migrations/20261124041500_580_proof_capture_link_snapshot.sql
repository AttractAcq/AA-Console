-- A capture link keeps the setup that was shared with its recipient. Existing
-- links can only be backfilled from the current setup, not reconstructed.
begin;

alter table public.proof_capture_links
  add column config_snapshot jsonb,
  add column config_snapshot_hash text,
  add column config_snapshot_origin text;

update public.proof_capture_links l set
  config_snapshot=jsonb_build_object('method',c.method,'name',c.name,
    'instructions',c.instructions,'config_updated_at',c.updated_at),
  config_snapshot_origin='backfilled_current_config'
from public.proof_capture_configs c
where c.id=l.config_id and c.client_id=l.client_id;

update public.proof_capture_links set
  config_snapshot_hash=encode(sha256(convert_to(config_snapshot::text,'UTF8')),'hex')
where config_snapshot is not null;

do $$ begin
  if exists(select 1 from public.proof_capture_links
    where config_snapshot is null or config_snapshot_hash is null) then
    raise exception 'A proof capture link has no same-client setup to snapshot.';
  end if;
end $$;

alter table public.proof_capture_links
  alter column config_snapshot set not null,
  alter column config_snapshot set default '{}'::jsonb,
  alter column config_snapshot_hash set not null,
  alter column config_snapshot_hash set default '',
  alter column config_snapshot_origin set not null,
  alter column config_snapshot_origin set default 'created_with_link',
  add constraint proof_capture_snapshot_origin_v7 check
    (config_snapshot_origin in ('created_with_link','backfilled_current_config'));

create function public.bind_proof_capture_link_setup_v7() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
declare c public.proof_capture_configs%rowtype;
begin
  if tg_op='INSERT' then
    select * into c from public.proof_capture_configs
      where id=new.config_id and client_id=new.client_id;
    if c.id is null then raise exception 'Capture setup belongs to another client.'; end if;
    new.config_snapshot:=jsonb_build_object('method',c.method,'name',c.name,
      'instructions',c.instructions,'config_updated_at',c.updated_at);
    new.config_snapshot_hash:=encode(sha256(convert_to(new.config_snapshot::text,'UTF8')),'hex');
    new.config_snapshot_origin:='created_with_link';
  elsif (new.client_id,new.config_id,new.config_snapshot,new.config_snapshot_hash,
      new.config_snapshot_origin) is distinct from
      (old.client_id,old.config_id,old.config_snapshot,old.config_snapshot_hash,
      old.config_snapshot_origin) then
    raise exception 'Capture link setup and source snapshot are immutable.';
  end if;
  return new;
end $$;
create trigger proof_capture_link_setup_v7 before insert or update
  on public.proof_capture_links for each row
  execute function public.bind_proof_capture_link_setup_v7();
revoke all on function public.bind_proof_capture_link_setup_v7()
  from public,anon,authenticated;

create or replace function public.accept_proof_capture_submission(
 p_token_hash text,p_submission_id uuid,p_name text,p_job_reference text,p_body text,
 p_storage_path text,p_mime text,p_category text,p_kind text,p_consent text
) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare l public.proof_capture_links%rowtype; existing uuid; pid uuid;
  v_method text; v_title text;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
 select * into l from public.proof_capture_links where token_hash=p_token_hash for update;
 if not found or l.revoked_at is not null or l.expires_at<=now() then raise exception 'Capture link unavailable'; end if;
 if l.config_snapshot_hash is distinct from
    encode(sha256(convert_to(l.config_snapshot::text,'UTF8')),'hex') then
   raise exception 'Capture link setup snapshot is invalid'; end if;
 v_method:=l.config_snapshot->>'method';
 v_title:=l.config_snapshot->>'name';
 if v_method not in ('automated_requests','field_capture','guided_interview',
    'manual_import','outcome_followup') or nullif(btrim(v_title),'') is null then
   raise exception 'Capture link setup snapshot is incomplete'; end if;
 select proof_id into existing from public.proof_capture_submissions
   where id=p_submission_id and link_id=l.id;
 if found then return existing; end if;
 if l.submissions>=l.max_submissions then raise exception 'Capture link unavailable'; end if;
 if nullif(btrim(p_name),'') is null or length(p_name)>200 or nullif(btrim(p_body),'') is null or length(p_body)>20000
   or nullif(btrim(p_consent),'') is null or length(p_consent)>2000 then raise exception 'Name, evidence and permission confirmation required'; end if;
 if p_storage_path is not null and p_storage_path <> l.client_id::text||'/capture/'||l.id::text||'/'||p_submission_id::text then raise exception 'Invalid upload path'; end if;
 if p_storage_path is not null and not exists(select 1 from storage.objects where bucket_id='proof' and name=p_storage_path) then raise exception 'Upload missing'; end if;
 pid:=gen_random_uuid();
 insert into public.client_proof_assets(id,client_id,media_type,title,body,storage_path,source,usage_rights,permission_basis,capture_method,source_category,source_kind,capture_file_mime)
 values(pid,l.client_id,case when p_mime like 'image/%' then 'image'::public.media_type when p_mime like 'video/%' then 'video'::public.media_type else 'text'::public.media_type end,
 left(v_title||' · '||p_name,300),p_body,p_storage_path,p_name,'not_cleared',p_consent,v_method,p_category,p_kind,p_mime);
 insert into public.proof_capture_submissions(id,client_id,link_id,proof_id,submitted_name,job_reference,consent_text,file_mime)
 values(p_submission_id,l.client_id,l.id,pid,p_name,left(p_job_reference,500),p_consent,p_mime);
 update public.proof_capture_links set submissions=submissions+1 where id=l.id;
 return pid;
end $$;
revoke all on function public.accept_proof_capture_submission(text,uuid,text,text,text,text,text,text,text,text)
  from public,anon,authenticated;
grant execute on function public.accept_proof_capture_submission(text,uuid,text,text,text,text,text,text,text,text)
  to service_role;

select public.lock_down_definer_functions();
commit;

alter table public.proof_production_requests
 add column auto_produce boolean not null default false,
 add column production_quality text not null default 'high' check(production_quality in ('low','medium','high')),
 add column production_size text not null default '1024x1536' check(production_size in ('1024x1536','1024x1024','1536x1024')),
 add column production_job_id uuid references public.agent_jobs(id),
 add column production_status text not null default 'briefing' check(production_status in ('briefing','building','complete','failed','needs_attention')),
 add column production_error text,
 add column production_checked_at timestamptz not null default '-infinity';
create function public.request_proof_auto_production(
 p_request_id uuid,p_client_id uuid,p_source_proof_id uuid,p_source_asset_id uuid,
 p_media_type public.media_type,p_format public.content_format,p_direction text,p_destination text,
 p_quality text default 'high',p_size text default '1024x1536'
) returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare rid uuid; r public.proof_production_requests%rowtype;
begin
 if p_quality is null or p_quality not in ('low','medium','high') or p_size is null or p_size not in ('1024x1536','1024x1024','1536x1024') then raise exception 'Choose a supported quality and size'; end if;
 if p_format='story' and p_size<>'1024x1536' then raise exception 'Stories require portrait size'; end if;
 if p_media_type='video' and p_format<>'reel' then raise exception 'Automatic video production currently supports reels. Use the existing human Create workflow for other video formats.'; end if;
 rid:=public.request_proof_production_v2(p_request_id,p_client_id,p_source_proof_id,p_source_asset_id,p_media_type,p_format,p_direction,p_destination);
 select * into r from public.proof_production_requests where id=rid for update;
 if r.auto_produce and (r.production_quality<>p_quality or r.production_size<>p_size) then raise exception 'Request ID already used with different production options'; end if;
 update public.proof_production_requests set auto_produce=true,production_quality=p_quality,production_size=p_size where id=rid;
 return rid;
end $$;
revoke all on function public.request_proof_auto_production(uuid,uuid,uuid,uuid,public.media_type,public.content_format,text,text,text,text) from public,anon;
grant execute on function public.request_proof_auto_production(uuid,uuid,uuid,uuid,public.media_type,public.content_format,text,text,text,text) to authenticated;

-- Extend the existing builder only for a service worker fulfilling a saved proof request.
-- Authenticated v1 callers retain the exact original admin requirement.
do $$ declare definition text; begin
 definition:=pg_get_functiondef('public.build_brief_with_ai(uuid,text,text,text,integer,text[])'::regprocedure);
 if position('if not is_admin() then' in definition)=0 then raise exception 'Builder authorization changed; review migration before applying'; end if;
 definition:=replace(definition,'if not is_admin() then',
 'if not is_admin() and not (auth.role() = ''service_role'' and exists (
 select 1 from public.proof_production_requests r join public.client_briefs b on b.source_idea_id=r.idea_id and b.client_id=r.client_id
 where b.id=p_brief_id and r.auto_produce and r.production_job_id is null and r.production_status=''briefing''
 )) then');
 execute definition;
end $$;
grant execute on function public.build_brief_with_ai(uuid,text,text,text,integer,text[]) to service_role;

create function public.advance_proof_production() returns int
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.proof_production_requests%rowtype; b public.client_briefs%rowtype; jid uuid; advanced int:=0; jobstate text; joberror text; jobterminal boolean;
begin
 if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
 for r in select * from public.proof_production_requests where auto_produce and production_status in ('briefing','building') order by production_checked_at,created_at for update skip locked limit 10 loop
  begin
   update public.proof_production_requests set production_checked_at=now() where id=r.id;
   if not exists(select 1 from public.client_proof_assets p where p.id=r.source_proof_id and p.client_id=r.client_id and p.usage_rights='approved' and (p.expires_on is null or p.expires_on>=current_date) and nullif(btrim(p.permission_basis),'') is not null) then
    update public.proof_production_requests set production_status='needs_attention',production_error='Source permission expired or was revoked.' where id=r.id; continue;
   end if;
   if r.production_status='briefing' then
    select * into b from public.client_briefs where source_idea_id=r.idea_id and client_id=r.client_id for update;
    if not found then
      select status,error,terminal into jobstate,joberror,jobterminal from public.agent_jobs where id=r.job_id;
      if jobstate='cancelled' or (jobstate='failed' and jobterminal) then update public.proof_production_requests set production_status='failed',production_error=coalesce(joberror,'Brief generation failed') where id=r.id; end if;
      continue;
    end if;
    if b.media_type='video' and b.format_code is not null and b.format_code not in ('F6','F7') then
     update public.proof_production_requests set production_status='needs_attention',production_error='This video requires the human Create workflow; automatic reels support F6/F7.' where id=r.id; continue;
    end if;
    -- A manual Create action can race the coordinator. Never build the same brief twice.
    if b.status='in_production' or exists(select 1 from public.client_media_assets where brief_id=b.id) then
     update public.proof_production_requests set production_status='needs_attention',production_error='This brief already entered production. Use its existing output or job.' where id=r.id; continue;
    end if;
    jid:=public.build_brief_with_ai(b.id,r.production_quality,r.production_size,null,null,null);
    update public.proof_production_requests set production_job_id=jid,production_status='building',production_error=null where id=r.id;
    advanced:=advanced+1;
   else
    select status,error,terminal into jobstate,joberror,jobterminal from public.agent_jobs where id=r.production_job_id;
    if jobstate='cancelled' or (jobstate='failed' and jobterminal) then
      update public.proof_production_requests set production_status='failed',production_error=coalesce(joberror,'Production failed') where id=r.id;
    elsif jobstate='completed' and exists(select 1 from public.agent_jobs j join public.client_media_assets a on j.input_id=a.id and j.input_table='client_media_assets' join public.client_briefs x on x.id=a.brief_id where x.source_idea_id=r.idea_id and j.agent_key='video_edit' and j.status='failed' and j.terminal and a.render_path is null) then
      update public.proof_production_requests set production_status='needs_attention',production_error='Video assembly failed. Open the video in Edit to inspect and retry.' where id=r.id;
    elsif jobstate='completed' and exists(select 1 from public.client_media_assets a join public.client_briefs x on x.id=a.brief_id
      where x.source_idea_id=r.idea_id and (a.media_type<>'video' or a.render_path is not null)) then
      update public.proof_production_requests set production_status='complete',production_error=null where id=r.id;
    end if;
   end if;
  exception when others then
   update public.proof_production_requests set production_status='needs_attention',production_error=left(SQLERRM,1000) where id=r.id;
  end;
 end loop;
 return advanced;
end $$;
revoke all on function public.advance_proof_production() from public,anon,authenticated;
grant execute on function public.advance_proof_production() to service_role;

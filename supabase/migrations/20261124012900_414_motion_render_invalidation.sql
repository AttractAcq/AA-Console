-- Every changed input advances the review epoch, including edit-and-revert.
begin;
create function public.invalidate_motion_render_candidate_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if (new.render_path,new.poster_path,new.duration_sec,new.job_id,
  new.brand_qa,new.brand_qa_detail,new.claim_qa,new.claim_qa_detail,
  new.benchmark_note,new.proof_source_lost,new.render_bytes_sha256,new.render_file_bytes,
  new.render_object_id,new.render_object_version,new.render_object_updated_at)
  is distinct from
  (old.render_path,old.poster_path,old.duration_sec,old.job_id,
   old.brand_qa,old.brand_qa_detail,old.claim_qa,old.claim_qa_detail,
   old.benchmark_note,old.proof_source_lost,old.render_bytes_sha256,old.render_file_bytes,
   old.render_object_id,old.render_object_version,old.render_object_updated_at) then
  update public.motion_render_review_requests_v6 set request_token=gen_random_uuid()
   where candidate_id=new.id;
 end if;
 return new;
end $$;
create trigger motion_render_candidate_invalidation_v6 after update on public.motion_render_candidates
 for each row execute function public.invalidate_motion_render_candidate_v6();

create function public.invalidate_motion_render_project_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if (new.prompt,new.preset,new.scene_plan,new.client_id)
  is distinct from (old.prompt,old.preset,old.scene_plan,old.client_id) then
  update public.motion_render_review_requests_v6 q set request_token=gen_random_uuid()
   where exists(select 1 from public.motion_render_candidates c
    where c.id=q.candidate_id and c.project_id=new.id);
 end if;
 return new;
end $$;
create trigger motion_render_project_invalidation_v6 after update on public.motion_design_projects
 for each row execute function public.invalidate_motion_render_project_v6();

create function public.invalidate_motion_render_scene_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_project uuid;
begin
 if tg_op='DELETE' then v_project:=old.project_id; else v_project:=new.project_id; end if;
 update public.motion_render_review_requests_v6 q set request_token=gen_random_uuid()
  where exists(select 1 from public.motion_render_candidates c
   where c.id=q.candidate_id and c.project_id=v_project);
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger motion_render_scene_invalidation_v6 after insert or update or delete on public.motion_scenes
 for each row execute function public.invalidate_motion_render_scene_v6();

create function public.invalidate_motion_render_proof_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_proof uuid;
begin
 if tg_op='DELETE' then v_proof:=old.id; else v_proof:=new.id; end if;
 update public.motion_render_review_requests_v6 q set request_token=gen_random_uuid()
  where exists(select 1 from public.motion_render_candidates c
   join public.motion_scenes s on s.project_id=c.project_id
   where c.id=q.candidate_id and s.proof_asset_id=v_proof);
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger motion_render_proof_invalidation_v6 after update of usage_rights,expires_on or delete
 on public.client_proof_assets for each row execute function public.invalidate_motion_render_proof_v6();

-- The FK clears scene.proof_asset_id on deletion. Preserve the lost-source
-- fact on every candidate before that happens, so a new request cannot pass.
create function public.hold_motion_render_deleted_proof_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 update public.motion_render_candidates c set proof_source_lost=true
  where exists(select 1 from public.motion_scenes s
   where s.project_id=c.project_id and s.proof_asset_id=old.id);
 return old;
end $$;
create trigger motion_render_deleted_proof_hold_v6 before delete on public.client_proof_assets
 for each row execute function public.hold_motion_render_deleted_proof_v6();

create function public.invalidate_motion_render_storage_v6()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,storage as $$
declare v_name text;
begin
 if tg_op='DELETE' then v_name:=old.name; else v_name:=new.name; end if;
 if (tg_op='DELETE' and old.bucket_id='client-media')
  or (tg_op='UPDATE' and (old.bucket_id='client-media' or new.bucket_id='client-media')
   and (new.id,new.bucket_id,new.name,new.version,new.updated_at)
    is distinct from (old.id,old.bucket_id,old.name,old.version,old.updated_at)) then
  update public.motion_render_review_requests_v6 q set request_token=gen_random_uuid()
   where exists(select 1 from public.motion_render_candidates c
    where c.id=q.candidate_id and c.render_path in (v_name,old.name));
  update public.motion_render_candidates set render_bytes_sha256=null,render_file_bytes=null,
   render_object_id=null,render_object_version=null,render_object_updated_at=null
   where render_path in (v_name,old.name);
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger motion_render_storage_invalidation_v6 after update or delete on storage.objects
 for each row execute function public.invalidate_motion_render_storage_v6();

create function public.motion_render_acceptance_current_v6(p_candidate_id uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare c public.motion_render_candidates%rowtype; q public.motion_render_review_requests_v6%rowtype;
 e public.approval_decision_events_v6%rowtype;
begin
 select * into c from public.motion_render_candidates where id=p_candidate_id;
 if c.id is null or c.accepted_at is null or c.accepted_request_id is null
  or (auth.role() is distinct from 'service_role' and
   (auth.role() is distinct from 'authenticated' or not public.can_access_client(c.client_id)))
  then return false; end if;
 select * into q from public.motion_render_review_requests_v6
  where canonical_request_id=c.accepted_request_id and candidate_id=c.id;
 select * into e from public.approval_decision_events_v6
  where request_id=c.accepted_request_id order by event_order desc limit 1;
 return q.id is not null and e.decision='approved' and e.actor_aal='aal2'
  and e.actor_id=c.accepted_by and e.artifact_hash=q.source_hash
  and c.accepted_content_hash=q.source_hash
  and public.motion_render_review_source_state_v6(c.accepted_request_id)='source_decided'
  and not exists(select 1 from public.delivery_approval_invalidations_v6 i
   where i.approval_request_id=c.accepted_request_id);
end $$;
revoke all on function public.motion_render_acceptance_current_v6(uuid) from public,anon,authenticated,service_role;
grant execute on function public.motion_render_acceptance_current_v6(uuid) to authenticated,service_role;
revoke all on function public.invalidate_motion_render_candidate_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_motion_render_project_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_motion_render_scene_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_motion_render_proof_v6() from public,anon,authenticated,service_role;
revoke all on function public.hold_motion_render_deleted_proof_v6() from public,anon,authenticated,service_role;
revoke all on function public.invalidate_motion_render_storage_v6() from public,anon,authenticated,service_role;
select public.lock_down_definer_functions();
commit;

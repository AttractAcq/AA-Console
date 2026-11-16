-- Recruitment creative may be queued only from a current exact brief signoff.
-- The shared build RPC is directly callable, so the queue boundary also checks it.
begin;

create or replace function public.generate_recruitment_ad(
  p_brief_id uuid,
  p_quality text default 'medium',
  p_size text default '1024x1536'
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public as $$
declare
  b public.client_briefs%rowtype;
  v_gen uuid;
  v_render uuid;
  v_job uuid;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can generate a recruitment ad.';
  end if;
  select * into b from public.client_briefs where id=p_brief_id for update;
  if b.id is null then raise exception 'That brief does not exist.'; end if;
  if b.purpose <> 'recruitment' then raise exception 'That is not a recruitment brief.'; end if;
  if b.status <> 'approved' then
    raise exception 'Approve the recruitment brief before generating.';
  end if;
  if b.media_type <> 'image' then
    raise exception 'Recruitment ads are Meta static (image) only.';
  end if;
  if not public.recruitment_brief_signoff_current_v6(b.id) then
    raise exception 'Current exact Inbox signoff is required before recruitment production.'
      using errcode='42501';
  end if;

  update public.client_briefs set production_method='ai' where id=b.id;
  v_gen:=public.build_brief_with_ai(b.id,p_quality,p_size,null);
  select r.id,r.job_id into v_render,v_job from public.creative_renders r
    where r.generation_id=v_gen order by r.created_at desc limit 1;
  if v_render is null then
    raise exception 'Generation did not create a render — creative_build cannot run.';
  end if;
  return jsonb_build_object('generation_id',v_gen,'render_id',v_render,'job_id',v_job);
end $$;

create function public.guard_recruitment_creative_job_v6()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
declare
  v_render_id uuid;
  v_brief public.client_briefs%rowtype;
begin
  if new.agent_key <> 'creative_build' then return new; end if;
  if coalesce(new.params->>'render_id','') !~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return new;
  end if;
  v_render_id:=(new.params->>'render_id')::uuid;
  select b.* into v_brief from public.creative_renders r
    join public.creative_generations g on g.id=r.generation_id
    join public.client_briefs b on b.id=g.brief_id
    where r.id=v_render_id for share of b;
  if v_brief.id is null or v_brief.purpose <> 'recruitment' then return new; end if;
  if v_brief.client_id is distinct from new.client_id
    or not public.recruitment_brief_signoff_current_v6(v_brief.id) then
    raise exception 'Current exact Inbox signoff is required before recruitment production.'
      using errcode='42501';
  end if;
  return new;
end $$;
create trigger recruitment_creative_job_guard_v6
before insert or update of agent_key,client_id,params,input_table,input_id
on public.agent_jobs for each row
execute function public.guard_recruitment_creative_job_v6();

revoke all on function public.guard_recruitment_creative_job_v6()
  from public,anon,authenticated,service_role;

insert into public.approval_class_coverage_versions_v6
 (class_id,revision,class_key,title,source_state,source_evidence,
  decision_state,decision_evidence,executor_state,executor_evidence,blocker)
values (16,2,'recruitment_brief','Recruitment brief signoff',
 'verified','276 exact recruitment brief request and source snapshot',
 'verified','276 provisioned AAL2 source-owned Inbox decision',
 'blocked','455 generate RPC and shared creative job queue require current signoff; creative worker rechecks before provider calls',
 'Historical approved briefs need reconciliation; external Meta build remains held and no live provider receipt exists.');

select public.lock_down_definer_functions();
commit;

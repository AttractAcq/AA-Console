-- The deployed Remotion site is immutable per render and must be recorded
-- alongside the Lambda function and render ID before the result is accepted.
alter table public.video_project_render_attempts_v1
  add column serve_url text;
alter table public.video_project_render_attempts_v1
  add constraint video_render_attempt_site_v1 check (
    (state='claimed' and serve_url is null)
    or (state in ('started','failed','succeeded')
      and length(serve_url) between 12 and 2048
      and serve_url ~ '^https://[^[:space:]]+$')
    or (state='uncertain'
      and (serve_url is null
        or (length(serve_url) between 12 and 2048
          and serve_url ~ '^https://[^[:space:]]+$')))
  );

drop function public.record_video_project_lambda_handle_v1(
  uuid,uuid,text,text,text,text,text);
create function public.record_video_project_lambda_handle_v2(
  p_attempt_id uuid,p_job_id uuid,p_region text,p_function_name text,
  p_render_id text,p_bucket_name text,p_out_name text,p_serve_url text
) returns boolean language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
declare a public.video_project_render_attempts_v1%rowtype;
  p public.video_projects%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'Service Lambda handle write only.' using errcode='42501'; end if;
  select * into a from public.video_project_render_attempts_v1
    where id=p_attempt_id for update;
  select * into p from public.video_projects where id=a.project_id;
  if a.id is null or p.id is null or a.job_id is distinct from p_job_id
    or a.ir_version is distinct from p.ir_version
    or p.stage is distinct from 'timed'
    or coalesce(p_region,'') !~ '^[a-z]{2}-[a-z]+-[0-9]$'
    or coalesce(p_function_name,'') !~ '^[A-Za-z0-9_-]{1,64}$'
    or coalesce(p_render_id,'') !~ '^[A-Za-z0-9-]{1,128}$'
    or coalesce(p_bucket_name,'') !~ '^[a-z0-9.-]{3,63}$'
    or length(coalesce(p_serve_url,'')) not between 12 and 2048
    or coalesce(p_serve_url,'') !~ '^https://[^[:space:]]+$'
    or p_out_name is distinct from
      (p.id::text||'-'||replace(a.aspect,':','x')||'.mp4') then
    raise exception 'Lambda handle differs from the claimed render.'
      using errcode='23514'; end if;
  if a.state='started' and a.region is not distinct from p_region
    and a.function_name is not distinct from p_function_name
    and a.render_id is not distinct from p_render_id
    and a.bucket_name is not distinct from p_bucket_name
    and a.out_name is not distinct from p_out_name
    and a.serve_url is not distinct from p_serve_url then return true; end if;
  if a.state is distinct from 'claimed' then
    raise exception 'Render handle was already settled or changed.'
      using errcode='23514'; end if;
  update public.video_project_render_attempts_v1
    set state='started',region=p_region,function_name=p_function_name,
      render_id=p_render_id,bucket_name=p_bucket_name,out_name=p_out_name,
      serve_url=p_serve_url,started_at=clock_timestamp() where id=a.id;
  update public.video_projects set stage_error=
    'Lambda render running; wait for candidate readback.' where id=p.id;
  return true;
end $$;
revoke all on function public.record_video_project_lambda_handle_v2(
  uuid,uuid,text,text,text,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.record_video_project_lambda_handle_v2(
  uuid,uuid,text,text,text,text,text,text) to service_role;

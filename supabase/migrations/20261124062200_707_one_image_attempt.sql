begin;

-- Provision a row privately only after an operator approves a specific brief,
-- reviewed copy digest and UTC budget month. No client is enrolled by release.
create table agent_budget_private.image_permits (
  brief_id uuid primary key,
  client_id uuid not null,
  budget_month date not null,
  reviewed_sha256 text not null check(reviewed_sha256 ~ '^[0-9a-f]{64}$'),
  job_id uuid unique,
  dispatched_at timestamptz,
  request_id text,
  input_tokens integer,
  output_tokens integer,
  foreign key(client_id,budget_month) references agent_budget_private.caps(client_id,month)
);
revoke all on agent_budget_private.image_permits from public,anon,authenticated,service_role;

create function public.reviewed_image_attempt_state(p_client_id uuid)
returns table(brief_id uuid, job_id uuid, asset_id uuid)
language sql stable security definer set search_path=pg_catalog as $$
  select p.brief_id,p.job_id,a.id from agent_budget_private.image_permits p
  left join public.creative_renders r on r.job_id=p.job_id and r.client_id=p.client_id
  left join public.client_media_assets a on a.id=r.asset_id and a.brief_id=p.brief_id and a.client_id=p.client_id
    and a.review_status='pending' and a.archived_at is null and a.human_approved_at is null
  where auth.role()='authenticated' and public.is_admin() and public.can_access_client(p_client_id)
    and p.client_id=p_client_id and (p.job_id is not null or p.budget_month=date_trunc('month',now() at time zone 'UTC')::date)
$$;

create function agent_budget_private.reviewed_image_prompt(p agent_budget_private.image_permits, expected_status text)
returns text language sql stable set search_path=pg_catalog as $$
  select b.visual_direction from public.client_briefs b where b.id=p.brief_id and b.client_id=p.client_id
    and b.status::text=expected_status and b.archived_at is null and b.purpose='client'
    and b.media_type='image' and b.content_format='single' and b.proof_asset_id is null
    and b.excluded_artwork_proof_id is not null and nullif(btrim(b.visual_direction),'') is not null
    and encode(sha256(convert_to(jsonb_build_array(b.argument,b.script,b.visual_direction)::text,'UTF8')),'hex')=p.reviewed_sha256
$$;
revoke all on function agent_budget_private.reviewed_image_prompt(agent_budget_private.image_permits,text) from public,anon,authenticated,service_role;

create function public.queue_reviewed_image_attempt(p_client_id uuid,p_brief_id uuid) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare p agent_budget_private.image_permits; generation uuid; j uuid;
begin
  if auth.role() is distinct from 'authenticated' or not coalesce(public.is_admin() and public.can_access_client(p_client_id),false)
    or not exists(select 1 from public.profiles where id=auth.uid() and not is_bot) then raise insufficient_privilege; end if;
  select * into strict p from agent_budget_private.image_permits where client_id=p_client_id and brief_id=p_brief_id for update;
  if p.job_id is not null then return p.job_id; end if;
  perform 1 from public.client_briefs where id=p.brief_id for update;
  if p.budget_month<>date_trunc('month',now() at time zone 'UTC')::date
    or agent_budget_private.reviewed_image_prompt(p,'draft') is null
    or exists(select 1 from public.creative_generations where brief_id=p.brief_id)
    then raise exception 'The reviewed image permission is unavailable for this brief.'; end if;
  generation := public.build_brief_with_ai(p.brief_id,'medium','1024x1536',null,null,null);
  select job_id into strict j from public.creative_generations where id=generation and brief_id=p.brief_id and client_id=p.client_id;
  update public.agent_jobs set max_attempts=1 where id=j and status='queued';
  if not found then raise exception 'Image builder did not enqueue a job.'; end if;
  update agent_budget_private.image_permits set job_id=j where brief_id=p.brief_id;
  return j;
end $$;

-- Commit both the budget reservation and the non-repeatable dispatch marker
-- before returning the exact reviewed text. Never return a proof reference.
create function public.claim_reviewed_image_attempt(p_job_id uuid,p_render_id uuid,p_owner text) returns text
language plpgsql security definer set search_path=pg_catalog as $$
declare p agent_budget_private.image_permits; prompt text; allowance numeric;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  select * into strict p from agent_budget_private.image_permits where job_id=p_job_id for update;
  prompt := agent_budget_private.reviewed_image_prompt(p,'in_production');
  if prompt is null or p.dispatched_at is not null or p.budget_month<>date_trunc('month',now() at time zone 'UTC')::date
    or not exists(select 1 from public.creative_renders r join public.creative_generations g on g.id=r.generation_id
      join public.agent_jobs j on j.id=r.job_id where r.id=p_render_id and r.job_id=p.job_id and g.job_id=p.job_id
      and j.agent_key='creative_build' and j.client_id=p.client_id and j.max_attempts=1
      and j.params=jsonb_build_object('render_id',p_render_id) and r.client_id=p.client_id
      and g.client_id=p.client_id and g.brief_id=p.brief_id and g.media_type='image'
      and g.reference_path is null and r.reference_path is null and r.quality='medium' and r.size='1024x1536')
    then raise exception 'The image attempt is unavailable or already consumed.'; end if;
  -- Reuse the live dispatch hold acquired for this worker claim. This is
  -- money held toward this one call, not a provider maximum.
  select reserved_usd into strict allowance from agent_budget_private.reservations
    where job_id=p.job_id and attempt=1 and turn=0 and lease_owner=p_owner and actual_usd is null;
  perform public.reserve_agent_budget_turn(p.job_id,1,p_owner,1,allowance);
  update agent_budget_private.image_permits set dispatched_at=clock_timestamp() where brief_id=p.brief_id;
  return prompt;
end $$;

create function public.settle_reviewed_image_attempt(p_job_id uuid,p_owner text,p_request_id text,
  p_input integer,p_output integer) returns numeric
language plpgsql security definer set search_path=pg_catalog as $$
declare p agent_budget_private.image_permits; actual numeric;
begin
  if auth.role() is distinct from 'service_role' then raise insufficient_privilege; end if;
  select * into strict p from agent_budget_private.image_permits where job_id=p_job_id for update;
  if p.dispatched_at is null or nullif(btrim(p_request_id),'') is null or p_input is null or p_input<=0
    or p_output is null or p_output<=0 or (p.request_id is not null and
      (p.request_id,p.input_tokens,p.output_tokens) is distinct from (p_request_id,p_input,p_output))
    then raise exception 'Incomplete or conflicting image usage receipt.'; end if;
  -- GPT-Image-2 direct Images API: standard text input and image output.
  -- https://developers.openai.com/api/docs/pricing#image-generation
  actual := (p_input::numeric*5+p_output::numeric*30)/1000000;
  perform 1 from agent_budget_private.caps where client_id=p.client_id and month=p.budget_month for update;
  update agent_budget_private.caps set reservation_revision=reservation_revision+1 where client_id=p.client_id and month=p.budget_month;
  update agent_budget_private.reservations set reserved_usd=greatest(reserved_usd,actual),actual_usd=actual
    where job_id=p.job_id and client_id=p.client_id and month=p.budget_month and attempt=1 and turn=1
    and lease_owner=p_owner and (actual_usd is null or actual_usd=actual);
  if not found then raise exception 'Missing or conflicting image reservation.'; end if;
  update agent_budget_private.image_permits set request_id=p_request_id,input_tokens=p_input,output_tokens=p_output
    where job_id=p_job_id;
  return actual;
end $$;
revoke all on function public.reviewed_image_attempt_state(uuid),public.queue_reviewed_image_attempt(uuid,uuid) from public,anon,service_role;
grant execute on function public.reviewed_image_attempt_state(uuid),public.queue_reviewed_image_attempt(uuid,uuid) to authenticated;
revoke all on function public.claim_reviewed_image_attempt(uuid,uuid,text), public.settle_reviewed_image_attempt(uuid,text,text,integer,integer) from public,anon,authenticated;
grant execute on function public.claim_reviewed_image_attempt(uuid,uuid,text),public.settle_reviewed_image_attempt(uuid,text,text,integer,integer) to service_role;
commit;

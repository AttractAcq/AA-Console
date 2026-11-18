-- A strategy run must not leave half of its attributes or stage messages
-- committed when its final proposal cannot be saved. It must also refuse to
-- overwrite working-out that changed while the model was running.
begin;

create function public.opportunity_strategy_input_hash_v7(p_opportunity_id uuid)
returns text language plpgsql stable security definer
set search_path=pg_catalog,public as $$
declare
  o public.market_opportunities%rowtype;
  input jsonb;
begin
  select * into o from public.market_opportunities where id=p_opportunity_id;
  if o.id is null then raise exception 'Opportunity unavailable.' using errcode='P0001'; end if;
  if auth.role() is null or auth.role() not in ('authenticated','service_role')
    or (auth.role()='authenticated' and not public.can_access_client(o.client_id)) then
    raise exception 'Opportunity access required.' using errcode='42501';
  end if;
  select jsonb_build_object(
    'opportunity',to_jsonb(o),
    'intelligence',coalesce((select jsonb_agg(to_jsonb(r) order by r.id)
      from public.client_agent_records r where r.client_id=o.client_id
        and r.domain in ('market','icp','association','competitor',
          'brand_strategy','offer_strategy')),'[]'::jsonb),
    'attributes',coalesce((select jsonb_agg(to_jsonb(a) order by a.kind,a.position,a.id)
      from public.opportunity_attributes a where a.opportunity_id=o.id),'[]'::jsonb),
    'awareness',coalesce((select jsonb_agg(to_jsonb(s) order by s.stage)
      from public.opportunity_awareness_stages s where s.opportunity_id=o.id),'[]'::jsonb))
    into input;
  return encode(sha256(convert_to(input::text,'UTF8')),'hex');
end $$;

create function public.save_opportunity_strategy_draft_v7(
  p_opportunity_id uuid,p_client_id uuid,p_job_id uuid,p_input_hash text,
  p_attributes jsonb,p_stages jsonb,p_fields jsonb,
  p_rationale text,p_proposed_by text
) returns uuid language plpgsql security definer
set search_path=pg_catalog,public as $$
declare
  o public.market_opportunities%rowtype;
  v_existing uuid;
  v_new uuid;
  v_kind text;
  v_values text[];
  v_stage jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'The strategy worker is required.' using errcode='42501';
  end if;
  select * into o from public.market_opportunities
    where id=p_opportunity_id for update;
  if o.id is null or o.client_id is distinct from p_client_id then
    raise exception 'Opportunity and client do not match.' using errcode='42501';
  end if;
  if not exists(select 1 from public.agent_jobs j where j.id=p_job_id
    and j.client_id=p_client_id and j.input_table='market_opportunities'
    and j.input_id=p_opportunity_id and j.agent_key='opportunity_strategise') then
    raise exception 'Strategy job does not match the opportunity.' using errcode='42501';
  end if;
  select id into v_existing from public.opportunity_proposals
    where proposed_by_job_id=p_job_id and kind='strategy' order by proposed_at limit 1;
  if v_existing is not null then return v_existing; end if;
  if p_input_hash !~ '^[0-9a-f]{64}$' or p_input_hash is distinct from
      public.opportunity_strategy_input_hash_v7(p_opportunity_id) then
    raise exception 'The opportunity or its strategy sources changed. Request a new strategy run.'
      using errcode='23514';
  end if;
  if jsonb_typeof(p_attributes) is distinct from 'object'
    or jsonb_typeof(p_stages) is distinct from 'array'
    or jsonb_typeof(p_fields) is distinct from 'object' then
    raise exception 'Strategy draft is incomplete.' using errcode='23514';
  end if;
  foreach v_kind in array array['problem','outcome','motivation','trigger','objection'] loop
    if jsonb_typeof(p_attributes->v_kind) is distinct from 'array' then
      raise exception 'Strategy attributes are incomplete.' using errcode='23514';
    end if;
    select array_agg(value) into v_values
      from jsonb_array_elements_text(p_attributes->v_kind) as t(value);
    if coalesce(array_length(v_values,1),0)>0 then
      perform public.set_opportunity_attributes_v6(p_opportunity_id,v_kind,v_values);
    end if;
  end loop;
  for v_stage in select value from jsonb_array_elements(p_stages) as t(value) loop
    perform public.set_opportunity_awareness_v6(
      p_opportunity_id,v_stage->>'stage',v_stage->>'mindset',v_stage->>'message',
      v_stage->>'asset_direction',v_stage->>'distribution_note');
  end loop;
  update public.opportunity_proposals
    set resolution='superseded',resolved_at=now()
    where opportunity_id=p_opportunity_id and kind='strategy' and resolution='open';
  insert into public.opportunity_proposals(
    opportunity_id,client_id,kind,payload,rationale,proposed_by,proposed_by_job_id)
    values(p_opportunity_id,p_client_id,'strategy',
      jsonb_build_object('fields',p_fields,'input_hash',p_input_hash),
      p_rationale,p_proposed_by,p_job_id)
    returning id into v_new;
  return v_new;
end $$;

revoke all on function public.opportunity_strategy_input_hash_v7(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.opportunity_strategy_input_hash_v7(uuid)
  to authenticated,service_role;
revoke all on function public.save_opportunity_strategy_draft_v7(
  uuid,uuid,uuid,text,jsonb,jsonb,jsonb,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.save_opportunity_strategy_draft_v7(
  uuid,uuid,uuid,text,jsonb,jsonb,jsonb,text,text) to service_role;
select public.lock_down_definer_functions();
commit;

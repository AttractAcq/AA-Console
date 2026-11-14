-- Public sales-agent permission belongs to one exact operating definition.
-- Existing approved rows remain legacy; no new direct signature is accepted.
begin;
alter table public.client_sales_agents
  add column public_use_request_token uuid,
  add column approved_request_id uuid references public.approval_requests_v6(id),
  add column approved_content_hash text check (
    approved_content_hash is null or approved_content_hash ~ '^[0-9a-f]{64}$');

create function public.sales_agent_public_preview_v6(p_agent public.client_sales_agents)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'agent_id',p_agent.id,'client_id',p_agent.client_id,
    'request_token',p_agent.public_use_request_token,
    'name',p_agent.name,'purpose',p_agent.purpose,'role',p_agent.role,
    'page_id',p_agent.page_id,'status',p_agent.status,
    'built_at',p_agent.built_at,'archived_at',p_agent.archived_at,
    'greeting',p_agent.greeting,'system_prompt',p_agent.system_prompt,
    'qualification',p_agent.qualification,'objections',p_agent.objections,
    'booking_rule',p_agent.booking_rule,'escalation_rule',p_agent.escalation_rule,
    'guardrails',p_agent.guardrails);
$$;
create function public.sales_agent_public_hash_v6(p_agent public.client_sales_agents)
returns text language sql stable security definer
set search_path = pg_catalog, public as $$
  select encode(sha256(convert_to(
    (public.sales_agent_public_preview_v6(p_agent) - 'request_token')::text,
    'UTF8')), 'hex');
$$;
create function public.sales_agent_public_scope_v6(p_agent public.client_sales_agents)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public as $$
  select jsonb_build_object(
    'client_id',p_agent.client_id,'agent_id',p_agent.id,
    'page_id',p_agent.page_id,'request_token',p_agent.public_use_request_token,
    'script_hash',public.sales_agent_public_hash_v6(p_agent),
    'consequence','May answer visitors and capture leads only when live and attached to an enabled page');
$$;

create function public.sales_agent_public_source_state_v6(p_request_id uuid)
returns text language plpgsql stable security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare r public.approval_requests_v6%rowtype;
  a public.client_sales_agents%rowtype;
  h text;
begin
  select * into r from public.approval_requests_v6 where id = p_request_id;
  if not found or r.source_system <> 'aa_console'
    or r.source_kind <> 'sales_agent_public_use'
    or r.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then return 'unverified'; end if;
  if auth.role() is distinct from 'service_role' and
    (auth.role() is distinct from 'authenticated' or not
      public.can_review_approval_request_v6(r.client_id,r.owner_role))
    then return 'unverified'; end if;
  select * into a from public.client_sales_agents
    where id = r.source_id::uuid and client_id = r.client_id;
  if not found then return 'cancelled'; end if;
  h := public.sales_agent_public_hash_v6(a);
  if a.public_use_request_token is null
    or r.source_version is distinct from h || ':' || a.public_use_request_token::text
    or r.artifact_hash is distinct from h
    or r.preview is distinct from public.sales_agent_public_preview_v6(a)
    or r.scope is distinct from public.sales_agent_public_scope_v6(a)
    or r.destination is distinct from ('public_sales_agent:' || a.id::text)
    then return 'superseded'; end if;
  if a.status <> 'live' or a.archived_at is not null or a.built_at is null
    or a.page_id is null or not exists (select 1 from public.client_pages p
      where p.id = a.page_id and p.client_id = a.client_id)
    then return 'source_held'; end if;
  if a.approved_at is not null then
    if a.approved_request_id = r.id and a.approved_content_hash = h
      then return 'source_decided'; end if;
    return 'source_held';
  end if;
  return 'pending';
end $$;

create function public.request_sales_agent_public_use_v6(p_agent_id uuid)
returns uuid language plpgsql volatile security definer
set search_path = pg_catalog, public set timezone = 'UTC' as $$
declare a public.client_sales_agents%rowtype;
  h text; v_existing uuid;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or public.current_role_of() is null then
    raise exception 'A provisioned human must request public use.' using errcode = '42501';
  end if;
  select * into a from public.client_sales_agents where id = p_agent_id for update;
  if not found or not (coalesce(public.is_admin(),false)
    or coalesce(auth.uid() = public.active_video_approval_manager(a.client_id),false)) then
    raise exception 'The agent or its decision owner is unavailable.' using errcode = '42501';
  end if;
  if a.status <> 'live' or a.archived_at is not null or a.built_at is null
    or a.page_id is null or not exists (select 1 from public.client_pages p
      where p.id = a.page_id and p.client_id = a.client_id)
    or nullif(btrim(coalesce(a.system_prompt,'')),'') is null
    or nullif(btrim(coalesce(a.greeting,'')),'') is null
    or nullif(btrim(coalesce(a.guardrails,'')),'') is null then
    raise exception 'Build a complete live agent bound to this client''s page before requesting public use.'
      using errcode = '23514';
  end if;
  if a.approved_at is not null then
    raise exception 'This agent is already approved; revoke or revise it first.'
      using errcode = '23514';
  end if;
  h := public.sales_agent_public_hash_v6(a);
  if a.public_use_request_token is not null then
    select r.id into v_existing from public.approval_requests_v6 r
      where r.source_system = 'aa_console'
        and r.source_kind = 'sales_agent_public_use'
        and r.source_id = a.id::text
        and r.source_version = h || ':' || a.public_use_request_token::text
        and r.expires_at > now();
    if v_existing is not null and
      public.sales_agent_public_source_state_v6(v_existing) = 'pending'
      and exists (select 1 from public.approval_inbox_v6 i
        where i.id = v_existing and i.status = 'pending')
      then return v_existing; end if;
  end if;
  update public.client_sales_agents set public_use_request_token = gen_random_uuid()
    where id = a.id returning * into a;
  return public.register_approval_request_v6(jsonb_build_object(
    'client_id',a.client_id,'source_system','aa_console',
    'source_kind','sales_agent_public_use','source_id',a.id::text,
    'source_version',h || ':' || a.public_use_request_token::text,
    'title','Sales agent public use: ' || a.name,
    'artifact_hash',h,'preview',public.sales_agent_public_preview_v6(a),
    'destination','public_sales_agent:' || a.id::text,
    'scope',public.sales_agent_public_scope_v6(a),
    'owner_role','admin_or_active_client_manager',
    'requested_by',auth.uid(),'requester_kind','human',
    'expires_at',now() + interval '7 days',
    'owning_path','/clients/' || a.client_id::text || '/delivery/sales-os?agent=' || a.id::text));
end $$;

revoke all on function public.sales_agent_public_preview_v6(public.client_sales_agents)
  from public,anon,authenticated,service_role;
revoke all on function public.sales_agent_public_hash_v6(public.client_sales_agents)
  from public,anon,authenticated,service_role;
revoke all on function public.sales_agent_public_scope_v6(public.client_sales_agents)
  from public,anon,authenticated,service_role;
revoke all on function public.sales_agent_public_source_state_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.sales_agent_public_source_state_v6(uuid)
  to authenticated,service_role;
revoke all on function public.request_sales_agent_public_use_v6(uuid)
  from public,anon,service_role;
grant execute on function public.request_sales_agent_public_use_v6(uuid)
  to authenticated;
select public.lock_down_definer_functions();
commit;

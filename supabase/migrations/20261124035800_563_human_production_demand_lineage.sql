-- A human assignment counts for one production request only when explicitly
-- bound to its exact workflow run and piece. Shared brief IDs are insufficient.
create table public.assignment_demand_bindings_v7 (
  assignment_id uuid primary key references public.job_assignments(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  run_id uuid not null references public.workflow_runs(id) on delete cascade,
  demand_kind text not null check (demand_kind in ('daily','campaign')),
  demand_id uuid not null,
  brief_id uuid not null references public.client_briefs(id) on delete restrict,
  bound_at timestamptz not null default now()
);
create index assignment_demand_bindings_v7_demand_idx
  on public.assignment_demand_bindings_v7(client_id,demand_kind,demand_id);
alter table public.assignment_demand_bindings_v7 enable row level security;
create policy assignment_demand_bindings_v7_read
  on public.assignment_demand_bindings_v7 for select to authenticated
  using (public.can_access_client(client_id));
revoke all on public.assignment_demand_bindings_v7 from public,anon,authenticated;
grant select on public.assignment_demand_bindings_v7 to authenticated;
grant all on public.assignment_demand_bindings_v7 to service_role;

create function public.refuse_assignment_demand_change_v7() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
  raise exception 'A production assignment binding is append-only.';
end $$;
create trigger assignment_demand_append_only_v7
  before update or delete on public.assignment_demand_bindings_v7
  for each row execute function public.refuse_assignment_demand_change_v7();
revoke all on function public.refuse_assignment_demand_change_v7()
  from public,anon,authenticated;

create function public.create_demand_assignment_v7(
  p_member_id uuid, p_client_id uuid, p_brief_id uuid,
  p_demand_kind text, p_demand_id uuid, p_title text,
  p_due_date date default null, p_compensation numeric default null
) returns public.job_assignments
language plpgsql volatile security definer
set search_path = pg_catalog, public as $$
declare d record; a public.job_assignments%rowtype;
begin
  if auth.role() is distinct from 'service_role'
    and (auth.uid() is null or not coalesce(public.is_human_admin(),false)) then
    raise exception 'A human administrator is required.' using errcode='42501';
  end if;
  if p_brief_id is null or p_demand_id is null or p_member_id is null
    or p_client_id is null or nullif(btrim(p_title),'') is null
    or p_demand_kind not in ('daily','campaign') then
    raise exception 'Assignment, brief and exact demand are required.';
  end if;
  if not exists (select 1 from public.team_members m
      where m.id=p_member_id and m.active) then
    raise exception 'Active maker not found.';
  end if;
  if not exists (select 1 from public.client_briefs b
      where b.id=p_brief_id and b.client_id=p_client_id) then
    raise exception 'Brief does not belong to this client.';
  end if;
  select * into d from public.production_demand_v7
    where client_id=p_client_id and demand_kind=p_demand_kind
      and demand_id=p_demand_id;
  if not found or not exists (
    select 1 from public.workflow_steps s
    where s.run_id=d.run_id and s.step_key like d.piece_key || '\_%' escape '\'
      and s.input_table='client_briefs'
      and coalesce(s.resolved_input_id,s.input_id)=p_brief_id
  ) then
    raise exception 'Brief is not the input to this exact production request.';
  end if;
  insert into public.job_assignments
    (member_id,client_id,brief_id,title,due_date,compensation)
  values (p_member_id,p_client_id,p_brief_id,btrim(p_title),p_due_date,p_compensation)
  returning * into a;
  insert into public.assignment_demand_bindings_v7
    (assignment_id,client_id,run_id,demand_kind,demand_id,brief_id)
  values (a.id,p_client_id,d.run_id,p_demand_kind,p_demand_id,p_brief_id);
  return a;
end $$;
revoke all on function public.create_demand_assignment_v7(
  uuid,uuid,uuid,text,uuid,text,date,numeric) from public,anon,authenticated;
grant execute on function public.create_demand_assignment_v7(
  uuid,uuid,uuid,text,uuid,text,date,numeric) to authenticated,service_role;

create function public.guard_assignment_demand_binding_v7() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
  if exists (select 1 from public.assignment_demand_bindings_v7 b
      where b.assignment_id=new.id)
    and (new.client_id,new.brief_id,new.member_id) is distinct from
        (old.client_id,old.brief_id,old.member_id) then
    raise exception 'A production assignment cannot be retargeted.';
  end if;
  return new;
end $$;
create trigger assignment_demand_no_retarget_v7
  before update of client_id,brief_id,member_id on public.job_assignments
  for each row execute function public.guard_assignment_demand_binding_v7();
revoke all on function public.guard_assignment_demand_binding_v7()
  from public,anon,authenticated;

create view public.production_attempts_v8 with (security_invoker=true) as
select client_id,run_id,demand_kind,demand_id,campaign_id,
  route_package_id,destination,media_type,content_format,piece_key,
  attempt_id,attempt_kind,attempt_status,job_id,asset_id,cost_usd,
  created_at,revised,human_review_status,accepted_workflow_output
from public.production_attempts_v7
union all
select d.client_id,d.run_id,d.demand_kind,d.demand_id,d.campaign_id,
  d.route_package_id,d.destination,d.media_type,d.content_format,d.piece_key,
  h.id,'human_delivery'::text,'delivered'::text,null::uuid,h.asset_id,
  null::numeric,h.delivered_at,
  exists(select 1 from public.assignment_deliveries_v7 prior
    where prior.assignment_id=h.assignment_id
      and (prior.delivered_at,prior.id)<(h.delivered_at,h.id)),
  m.review_status::text,h.asset_id=d.accepted_asset_id
from public.assignment_deliveries_v7 h
join public.assignment_demand_bindings_v7 b on b.assignment_id=h.assignment_id
  and b.client_id=h.client_id
join public.production_demand_v7 d on d.run_id=b.run_id
  and d.client_id=b.client_id and d.demand_kind=b.demand_kind
  and d.demand_id=b.demand_id
join public.client_media_assets m on m.id=h.asset_id
  and m.client_id=d.client_id and m.brief_id=b.brief_id;

create view public.production_demand_counts_v8 with (security_invoker=true) as
select d.client_id,d.run_id,d.demand_kind,d.demand_id,d.campaign_id,
  d.route_package_id,d.destination,d.media_type,d.content_format,
  d.piece_key,d.accepted_asset_id,
  count(a.attempt_id)::integer as attempts,
  count(a.attempt_id) filter (where a.asset_id is not null
    and a.attempt_status in ('done','accepted','delivered'))::integer as produced,
  count(a.attempt_id) filter (where a.attempt_status in ('failed','rejected')
    or a.human_review_status='rejected')::integer as rejected,
  count(a.attempt_id) filter (where a.revised)::integer as revised,
  count(distinct a.asset_id) filter (where a.accepted_workflow_output)::integer
    as workflow_accepted,
  count(distinct a.asset_id) filter (where a.human_review_status='approved')::integer
    as human_approved
from public.production_demand_v7 d
left join public.production_attempts_v8 a on a.demand_kind=d.demand_kind
  and a.demand_id=d.demand_id
group by d.client_id,d.run_id,d.demand_kind,d.demand_id,d.campaign_id,
  d.route_package_id,d.destination,d.media_type,d.content_format,
  d.piece_key,d.accepted_asset_id;

grant select on public.production_attempts_v8,
  public.production_demand_counts_v8 to authenticated,service_role;
comment on view public.production_demand_counts_v8 is
  'Exact AI job and explicitly bound human assignment attempts for each campaign/daily demand. Workflow QA and human review remain separate; older unbound human deliveries have unknown demand.';

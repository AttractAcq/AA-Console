-- A proof request owns one idea, whose brief is the durable parent of every
-- derivative. This keeps failed/revised renders visible without attaching
-- unrelated assets merely because they share the same proof source.
-- An assignment can be reworked repeatedly. Its asset_id is the latest
-- delivery, so retain each exact handoff before a later upload replaces it.
create table public.assignment_deliveries_v7 (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.job_assignments(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  asset_id uuid not null references public.client_media_assets(id) on delete restrict,
  delivered_at timestamptz not null default now()
);
create index assignment_deliveries_v7_assignment_idx
  on public.assignment_deliveries_v7(assignment_id,delivered_at desc);
create index assignment_deliveries_v7_asset_idx
  on public.assignment_deliveries_v7(asset_id);
alter table public.assignment_deliveries_v7 enable row level security;
create policy assignment_deliveries_v7_read on public.assignment_deliveries_v7
  for select to authenticated using (public.can_access_client(client_id));
grant select on public.assignment_deliveries_v7 to authenticated;
grant all on public.assignment_deliveries_v7 to service_role;

create function public.refuse_assignment_delivery_change_v7() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
  if tg_op = 'UPDATE' or exists
      (select 1 from public.job_assignments a where a.id=old.assignment_id) then
    raise exception 'Assignment delivery history is append-only.';
  end if;
  return old;
end $$;
create trigger assignment_delivery_append_only_v7
  before update or delete on public.assignment_deliveries_v7
  for each row execute function public.refuse_assignment_delivery_change_v7();
revoke all on function public.refuse_assignment_delivery_change_v7()
  from public,anon,authenticated;

-- Existing assignments expose only their latest asset. Preserve that one
-- without inventing earlier attempts that were never recorded.
insert into public.assignment_deliveries_v7
  (assignment_id,client_id,asset_id,delivered_at)
select a.id,a.client_id,m.id,coalesce(a.delivered_at,a.updated_at)
from public.job_assignments a
join public.client_media_assets m on m.id=a.asset_id
  and m.client_id=a.client_id and m.member_id=a.member_id
  and (a.brief_id is null or m.brief_id=a.brief_id)
where a.client_id is not null
  and a.stage in ('delivered','rework','approved');

create function public.record_assignment_delivery_v7() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
declare m public.client_media_assets%rowtype;
begin
  if new.stage <> 'delivered' or old.stage = new.stage or new.client_id is null then
    return new;
  end if;
  select * into m from public.client_media_assets where id=new.asset_id;
  if not found or m.client_id <> new.client_id
     or (new.brief_id is not null and m.brief_id is distinct from new.brief_id)
     or m.member_id is distinct from new.member_id then
    raise exception 'Delivered asset must belong to this client, brief and maker.';
  end if;
  insert into public.assignment_deliveries_v7(assignment_id,client_id,asset_id)
    values(new.id,new.client_id,m.id);
  return new;
end $$;
create trigger assignment_delivery_history_v7
  after update of stage on public.job_assignments
  for each row execute function public.record_assignment_delivery_v7();
revoke all on function public.record_assignment_delivery_v7()
  from public,anon,authenticated;

create view public.proof_production_attempts_v7 with (security_invoker = true) as
with candidates as (
  select r.id as request_id, r.client_id, cr.id as attempt_id,
    cr.asset_id, 'creative_render'::text as attempt_kind,
    cr.status::text as attempt_status, cr.cost_usd,
    cr.created_at, cr.updated_at as finished_at,
    (g.remake_feedback is not null) as revised
  from public.proof_production_requests r
  join public.client_briefs b on b.source_idea_id = r.idea_id
    and b.client_id = r.client_id
  join public.creative_generations g on g.brief_id = b.id
    and g.client_id = r.client_id
  join public.creative_renders cr on cr.generation_id = g.id
    and cr.client_id = r.client_id
  union all
  select r.id, r.client_id, vc.id, vc.asset_id,
    'video_cut'::text, vc.verdict, null::numeric,
    vc.created_at, vc.reviewed_at,
    (vc.attempt > 1 and j.params ? 'v5_video_revision')
  from public.proof_production_requests r
  join public.client_briefs b on b.source_idea_id = r.idea_id
    and b.client_id = r.client_id
  join public.client_media_assets m on m.brief_id = b.id
    and m.client_id = r.client_id
  join public.video_render_candidates vc on vc.asset_id = m.id
    and vc.client_id = r.client_id
  join public.agent_jobs j on j.id = vc.job_id
  union all
  select r.id, r.client_id, m.id, m.id,
    'human_delivery'::text, 'delivered'::text, null::numeric,
    m.created_at, m.updated_at, false
  from public.proof_production_requests r
  join public.client_briefs b on b.source_idea_id = r.idea_id
    and b.client_id = r.client_id
  join public.client_media_assets m on m.brief_id = b.id
    and m.client_id = r.client_id
  where exists (select 1 from public.assignment_deliveries_v7 d
      where d.asset_id = m.id and d.client_id = r.client_id)
    and not exists (select 1 from public.creative_renders cr where cr.asset_id = m.id)
)
select c.request_id, c.client_id, c.attempt_id, c.asset_id,
  c.attempt_kind, c.attempt_status, c.cost_usd, c.created_at,
  c.finished_at,
  case when c.finished_at is not null then
    greatest(0,extract(epoch from c.finished_at-c.created_at))::integer
    else null end as latency_seconds,
  c.revised, m.review_status::text as human_review_status,
  m.source_asset_id
from candidates c
left join public.client_media_assets m on m.id = c.asset_id
  and m.client_id = c.client_id;

create view public.proof_production_counts_v7 with (security_invoker = true) as
select r.id as request_id, r.client_id, r.source_proof_id,
  r.source_asset_id, r.destination,
  i.media_type::text as media_type, i.content_format::text as content_format,
  count(a.attempt_id)::integer as attempts,
  count(a.attempt_id) filter (where a.asset_id is not null and
    a.attempt_status in ('done','accepted','delivered'))::integer as produced,
  count(a.attempt_id) filter (where a.attempt_status in ('failed','rejected')
    or a.human_review_status = 'rejected')::integer as rejected,
  count(a.attempt_id) filter (where a.revised)::integer as revised,
  count(distinct a.asset_id) filter (where a.human_review_status = 'pending')::integer
    as awaiting_review,
  count(distinct a.asset_id) filter (where a.human_review_status = 'approved')::integer
    as human_approved,
  sum(a.cost_usd) as render_cost_usd
from public.proof_production_requests r
join public.client_ideas i on i.id = r.idea_id and i.client_id = r.client_id
left join public.proof_production_attempts_v7 a on a.request_id = r.id
group by r.id, r.client_id, r.source_proof_id, r.source_asset_id,
  r.destination, i.media_type, i.content_format;

grant select on public.proof_production_attempts_v7,
  public.proof_production_counts_v7 to authenticated, service_role;

comment on view public.proof_production_counts_v7 is
  'Exact proof-request attempts and current human-review state. A produced derivative remains awaiting review until a person approves its asset; proof source rights and external placement have separate gates.';

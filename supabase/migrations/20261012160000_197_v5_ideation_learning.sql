-- Freeze measured and human-reviewed evidence once for each ideation job.
-- Retries reuse the same context and cannot silently pick up later results.
create table ideation_learning_snapshots (
  job_id uuid primary key references agent_jobs(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object'),
  captured_at timestamptz not null default now()
);
create index ideation_learning_snapshots_client_idx
  on ideation_learning_snapshots (client_id, captured_at desc);
alter table ideation_learning_snapshots enable row level security;
create policy ideation_learning_snapshots_read on ideation_learning_snapshots
  for select to authenticated using (can_access_client(client_id));
grant select on ideation_learning_snapshots to authenticated;

create function capture_ideation_learning_context(p_job_id uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare v_job agent_jobs; v_evidence jsonb;
begin
  if auth.role() <> 'service_role' then raise exception 'AUTH: service role required'; end if;
  select * into v_job from agent_jobs where id = p_job_id;
  if v_job.id is null or v_job.agent_key <> 'ideation' or v_job.client_id is null then
    raise exception 'An ideation job with a client is required.';
  end if;
  select evidence into v_evidence from ideation_learning_snapshots where job_id = p_job_id;
  if found then return v_evidence; end if;

  with recent as (
    select a.run_id, a.record_id as asset_id, a.accepted_at, m.human_approved_at,
      left(coalesce(i.title, b.title, m.title, 'Untitled'), 180) as idea_title,
      left(coalesce(i.source_question, ''), 240) as source_question,
      left(coalesce(i.strategic_reason, ''), 240) as strategic_reason,
      (select left(r.reason, 240) from client_asset_reviews r
        where r.asset_id = m.id and r.decision = 'rejected' and r.reason is not null
        order by r.created_at desc limit 1) as rejection_reason
    from workflow_artifacts a
    join workflow_runs w on w.id = a.run_id and w.client_id = v_job.client_id
    join client_media_assets m on m.id = a.record_id and m.client_id = w.client_id
    left join client_briefs b on b.id = m.brief_id
    left join client_ideas i on i.id = b.source_idea_id
    where a.artifact_kind = 'asset'
      and (m.human_approved_at is not null or exists (
        select 1 from client_asset_reviews r where r.asset_id = m.id and r.decision = 'rejected'))
    order by a.accepted_at desc limit 12
  ), creative as (
    select recent.*,
      (select count(*)::integer from workflow_lead_attribution la
        join client_leads l on l.id = la.lead_id
        where la.run_id = recent.run_id and la.label = 'observed'
          and (l.source_asset_id = recent.asset_id or exists (
            select 1 from scheduled_posts sp where sp.id = l.source_post_id
              and sp.asset_id = recent.asset_id))) as observed_linked_leads
    from recent
  ), runs as (
    select id, review_ready_at from workflow_runs
    where client_id = v_job.client_id and review_ready_at is not null
    order by review_ready_at desc limit 5
  )
  select jsonb_build_object(
    'creative', coalesce((select jsonb_agg(jsonb_build_object(
      'run_id', c.run_id, 'asset_id', c.asset_id,
      'idea_title', c.idea_title, 'source_question', c.source_question,
      'strategic_reason', c.strategic_reason,
      'human_approved', c.human_approved_at is not null,
      'rejection_reason', c.rejection_reason,
      'observed_linked_leads', c.observed_linked_leads
    ) order by c.accepted_at desc) from creative c), '[]'::jsonb),
    'runs', coalesce((select jsonb_agg(workflow_run_outcomes(r.id)
      order by r.review_ready_at desc) from runs r), '[]'::jsonb)
  ) into v_evidence;

  insert into ideation_learning_snapshots(job_id, client_id, evidence)
  values (p_job_id, v_job.client_id, v_evidence)
  on conflict (job_id) do nothing;
  select evidence into v_evidence from ideation_learning_snapshots where job_id = p_job_id;
  return v_evidence;
end;
$$;
revoke all on function capture_ideation_learning_context(uuid) from public, anon, authenticated;
grant execute on function capture_ideation_learning_context(uuid) to service_role;
select lock_down_definer_functions();

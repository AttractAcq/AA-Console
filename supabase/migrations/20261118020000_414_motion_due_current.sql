-- The render list must not label legacy or stale acceptance as current.
begin;
create or replace view motion_candidate_due with (security_invoker = true) as
select
  c.id as candidate_id,
  c.client_id,
  c.project_id,
  p.prompt,
  p.preset,
  c.attempt,
  c.render_path,
  c.brand_qa,
  c.brand_qa_detail,
  c.claim_qa,
  c.claim_qa_detail,
  c.accepted_at,
  c.rejected_reason,
  c.benchmark_note,
  (select count(*) from public.motion_scenes s where s.project_id = c.project_id) as scenes,
  (select count(*) from public.motion_scenes s
    where s.project_id = c.project_id and s.proof_asset_id is not null) as scenes_citing_proof,
  -- A scene citing proof whose permission has gone is the expensive case: the
  -- cut is wrong and nothing about the render says so.
  (select count(*) from public.motion_scenes s
    join public.client_proof_assets pa on pa.id = s.proof_asset_id
   where s.project_id = c.project_id
     and (pa.usage_rights <> 'approved'
          or (pa.expires_on is not null and pa.expires_on < current_date))) as scenes_citing_lost_proof,
  case
    when c.render_path is null then 'Still rendering, or the render failed.'
    when c.proof_source_lost then 'A cited proof source was deleted. Rebuild and recheck the cut.'
    when (select count(*) from public.motion_scenes s
           join public.client_proof_assets pa on pa.id = s.proof_asset_id
          where s.project_id = c.project_id
            and (pa.usage_rights <> 'approved'
                 or (pa.expires_on is not null and pa.expires_on < current_date))) > 0
      then 'A scene cites proof that is no longer usable. The cut is wrong whatever the QA says.'
    when c.brand_qa = 'fail'
      then 'Brand QA failed: ' || coalesce(c.brand_qa_detail, 'no detail recorded') || '.'
    when c.claim_qa = 'fail'
      then 'Claim QA failed: ' || coalesce(c.claim_qa_detail, 'no detail recorded') || '.'
    when c.brand_qa is null or c.claim_qa is null
      then 'QA has not run on this candidate yet.'
    when c.rejected_reason is not null then 'A person rejected it: ' || c.rejected_reason
    when c.accepted_at is not null and public.motion_render_acceptance_current_v6(c.id) then 'Accepted.'
    when c.accepted_at is not null then 'Accepted before exact review, or review is stale; do not use this cut.'
    else null
  end as blocker
from public.motion_render_candidates c
join public.motion_design_projects p on p.id = c.project_id;

grant select on public.motion_candidate_due to authenticated;
commit;

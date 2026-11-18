-- Read-only predeployment check for migration 566. Run with a role that can
-- inspect both tables across clients; an RLS-filtered count is insufficient.
select count(*)::bigint as mismatched_assignment_briefs
from public.job_assignments a
join public.client_briefs b on b.id=a.brief_id
where a.client_id is distinct from b.client_id;

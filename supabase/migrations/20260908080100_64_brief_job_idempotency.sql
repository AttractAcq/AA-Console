-- Original brief generation produces one brief per job. Repurpose jobs
-- intentionally produce multiple rows, each with a non-null format.
-- This predicate survives deletion of the source idea (ON DELETE SET NULL).
-- Fail without deleting anything if historical duplicates need human review.
do $$
begin
  if exists (
    select job_id from client_briefs
    where job_id is not null and repurpose_format is null
    group by job_id having count(*) > 1
  ) then
    raise exception 'Original briefs have duplicate job_id values; review and resolve them before applying migration 64';
  end if;
end;
$$;
create unique index client_briefs_original_job_unique
  on client_briefs (job_id) where repurpose_format is null;

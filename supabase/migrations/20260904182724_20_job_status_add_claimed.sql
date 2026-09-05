-- ============================================================
-- AA Console · 20 · Add the 'claimed' job state
--
-- Split from the claim RPC migration on purpose: Postgres allows
-- ALTER TYPE ... ADD VALUE inside a transaction but forbids *using* the
-- new value until that transaction commits, so the RPC that references
-- 'claimed' has to be a separate migration.
--
-- claimed vs running is the difference between "a worker owns this" and
-- "an agent is actively working on it" — worth telling apart when a job
-- looks stuck.
-- ============================================================

alter type job_status add value if not exists 'claimed' before 'running';;

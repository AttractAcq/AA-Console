-- A job can be held, which is not the same as a job that broke.
--
-- When a client reaches its monthly cap, dispatchJob refuses the job and the
-- worker marks it failed, non-retryably. The slot fails with it. Nothing
-- resumes either when the cap is raised or when the month rolls over, so a
-- cap reached on the 3rd quietly throws away every piece of engine work for
-- the rest of that month -- and the only way out of a failed slot is back to
-- planned, which pays for the ideation, the brief and the build a second
-- time.
--
-- The same is true of a paused agent: claim_agent_job skips its work, which
-- is right, but anything already queued simply waits -- and anything the
-- tick tries to queue next is dispatched, refused and failed.
--
-- `failed` means something broke and a person should look. A monthly cap is
-- not that. It is "not now", it resolves without anybody doing anything, and
-- the work should still be there when it does.
--
-- This migration only adds the value. PostgreSQL will not let a new enum
-- value be used in the same transaction that adds it, and Supabase applies a
-- migration as one transaction, so everything that reads or writes 'paused'
-- is in 164.

alter type job_status add value if not exists 'paused' after 'queued';

comment on type job_status is
  'Where a job has got to. paused is held for a reason that will pass on its own -- a monthly cap, a paused agent -- and is resumed by resume_paused_jobs rather than by a person. failed means something broke.';

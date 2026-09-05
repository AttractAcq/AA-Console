-- Alone in its own migration on purpose: Postgres refuses to use an enum
-- value added by ALTER TYPE in the same transaction that added it. This is
-- the third time (see 20_job_status_add_claimed and 26_record_domain_add_proof).
alter type record_domain add value 'reporting';;

-- ============================================================
-- AA Console · 12 · DEV STAGE — every table readable by every role
--
-- ⚠️  TEMPORARY. Requested explicitly while the role/table matrix is
-- still being decided. A client user signing in today can SELECT every
-- other client's rows, and an employee can read finance and contracts.
--
-- Only SELECT is opened. Writes stay scoped by the policies from
-- migrations 01-08, so nothing can be corrupted across tenants.
--
-- TO REVERT, run:
--   do $$ declare r record; begin
--     for r in select tablename from pg_tables where schemaname='public' loop
--       execute format('drop policy if exists dev_open_read on public.%I', r.tablename);
--     end loop; end $$;
-- ...and the per-role read policies underneath become authoritative again.
-- ============================================================

do $$
declare
  r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format(
      'create policy dev_open_read on public.%I for select to authenticated using (true)',
      r.tablename
    );
  end loop;
end;
$$;

comment on schema public is
  'AA Console. NOTE: policy `dev_open_read` on every table opens SELECT to all authenticated roles (migration 12) while the role/table matrix is being defined. Drop those policies to restore per-role scoping.';;

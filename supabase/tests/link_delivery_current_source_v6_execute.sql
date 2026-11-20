-- Local schema test for migration 655. There is no database test job in CI.
-- Run from a clean local database after migrations, including this one:
--   supabase test db
-- Schema replay also asserts these grants in
-- supabase/verification/schema-replay-contract.sql.

begin;
select plan(5);

select ok(
  to_regprocedure(
    'public.link_delivery_current_source_v6(public.delivery_entity_versions_v6, text, text, text)'
  ) is not null,
  'link_delivery_current_source_v6(public.delivery_entity_versions_v6, text, text, text) exists'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.link_delivery_current_source_v6(public.delivery_entity_versions_v6, text, text, text)',
    'execute'),
  'authenticated cannot execute link_delivery_current_source_v6'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.link_delivery_current_source_v6(public.delivery_entity_versions_v6, text, text, text)',
    'execute')
  and not has_function_privilege(
    'public',
    'public.link_delivery_current_source_v6(public.delivery_entity_versions_v6, text, text, text)',
    'execute'),
  'anon and public cannot execute link_delivery_current_source_v6'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.link_delivery_current_source_v6(public.delivery_entity_versions_v6, text, text, text)',
    'execute'),
  'service_role keeps execute on link_delivery_current_source_v6'
);

select ok(
  has_function_privilege(
    'postgres',
    'public.link_delivery_current_source_v6(public.delivery_entity_versions_v6, text, text, text)',
    'execute'),
  'postgres keeps execute on link_delivery_current_source_v6'
);

select * from finish();
rollback;

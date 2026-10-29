-- Stable, secret-free catalog evidence for comparing clean and upgrade paths.
-- Includes application, bot, storage, auth and extension-facing schemas.
-- Omits row data, object OIDs, cron job IDs and creation times. SQL expressions
-- are hashed so an accidental literal credential cannot enter the artifact.
with target_schemas(schema_name) as (
  values ('public'::name), ('mcp_internal'::name), ('storage'::name),
         ('auth'::name), ('vault'::name), ('graphql_public'::name),
         ('cron'::name)
)
select jsonb_pretty(jsonb_build_object(
  'schemas', (
    select coalesce(jsonb_agg(jsonb_build_array(n.nspname,
      pg_get_userbyid(n.nspowner), coalesce(n.nspacl::text, ''))
      order by n.nspname), '[]'::jsonb)
    from pg_namespace n join target_schemas s on s.schema_name = n.nspname
  ),
  'relations', (
    select coalesce(jsonb_agg(jsonb_build_array(n.nspname, c.relname,
      c.relkind, c.relrowsecurity, c.relforcerowsecurity,
      pg_get_userbyid(c.relowner), coalesce(c.relacl::text, ''))
      order by n.nspname, c.relname, c.relkind), '[]'::jsonb)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join target_schemas s on s.schema_name = n.nspname
    where c.relkind in ('r', 'p', 'v', 'm', 'S', 'i', 'I', 'f')
  ),
  'columns', (
    select coalesce(jsonb_agg(jsonb_build_array(n.nspname, c.relname,
      a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
      coalesce(a.attacl::text, ''),
      md5(coalesce(pg_get_expr(d.adbin, d.adrelid), '')))
      order by n.nspname, c.relname, a.attnum), '[]'::jsonb)
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    join target_schemas s on s.schema_name = n.nspname
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where c.relkind in ('r', 'p', 'v', 'm', 'f')
      and a.attnum > 0 and not a.attisdropped
  ),
  'constraints', (
    select coalesce(jsonb_agg(jsonb_build_array(n.nspname,
      c.conrelid::regclass::text, c.conname, md5(pg_get_constraintdef(c.oid)))
      order by n.nspname, c.conrelid::regclass::text, c.conname), '[]'::jsonb)
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    join target_schemas s on s.schema_name = n.nspname
  ),
  'indexes', (
    select coalesce(jsonb_agg(jsonb_build_array(n.nspname, c.relname,
      i.indisunique, i.indisvalid, i.indisready,
      md5(pg_get_indexdef(i.indexrelid)))
      order by n.nspname, c.relname), '[]'::jsonb)
    from pg_index i join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    join target_schemas s on s.schema_name = n.nspname
  ),
  'functions', (
    select coalesce(jsonb_agg(jsonb_build_array(n.nspname, p.proname,
      pg_get_function_identity_arguments(p.oid), p.prosecdef,
      pg_get_userbyid(p.proowner), coalesce(p.proacl::text, ''),
      md5(pg_get_functiondef(p.oid)))
      order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), '[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    join target_schemas s on s.schema_name = n.nspname
  ),
  'policies', (
    select coalesce(jsonb_agg(jsonb_build_array(schemaname, tablename,
      policyname, permissive, roles, cmd, md5(coalesce(qual, '')),
      md5(coalesce(with_check, '')))
      order by schemaname, tablename, policyname), '[]'::jsonb)
    from pg_policies where schemaname in (select schema_name from target_schemas)
  ),
  'views', (
    select coalesce(jsonb_agg(jsonb_build_array(n.nspname, c.relname,
      md5(pg_get_viewdef(c.oid, true)))
      order by n.nspname, c.relname), '[]'::jsonb)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join target_schemas s on s.schema_name = n.nspname
    where c.relkind in ('v', 'm')
  ),
  'enums', (
    select coalesce(jsonb_agg(jsonb_build_array(n.nspname, t.typname,
      e.enumlabel) order by n.nspname, t.typname, e.enumsortorder), '[]'::jsonb)
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    join target_schemas s on s.schema_name = n.nspname
    join pg_enum e on e.enumtypid = t.oid
  ),
  'triggers', (
    select coalesce(jsonb_agg(jsonb_build_array(n.nspname, c.relname,
      t.tgname, t.tgenabled, md5(pg_get_triggerdef(t.oid, true)))
      order by n.nspname, c.relname, t.tgname), '[]'::jsonb)
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join target_schemas s on s.schema_name = n.nspname
    where not t.tgisinternal
  ),
  'default_acls', (
    select coalesce(jsonb_agg(jsonb_build_array(
      coalesce(n.nspname, '<global>'), pg_get_userbyid(a.defaclrole),
      a.defaclobjtype, coalesce(a.defaclacl::text, ''))
      order by coalesce(n.nspname, '<global>'),
        pg_get_userbyid(a.defaclrole), a.defaclobjtype), '[]'::jsonb)
    from pg_default_acl a left join pg_namespace n on n.oid = a.defaclnamespace
    where a.defaclnamespace = 0
       or n.nspname in (select schema_name from target_schemas)
  ),
  'extensions', (
    select coalesce(jsonb_agg(jsonb_build_array(e.extname, n.nspname,
      e.extversion) order by e.extname), '[]'::jsonb)
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  ),
  'cron', (
    select coalesce(jsonb_agg(jsonb_build_array(jobname, schedule,
      md5(command), active) order by jobname), '[]'::jsonb) from cron.job
  )
));

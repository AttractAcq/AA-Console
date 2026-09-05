-- Column introspection for the Master AI, so it can look before it writes.
-- Restricted to the public schema; it exposes shape, never row data.
create or replace function master_ai_describe_table(p_table text)
returns table (column_name text, data_type text, is_nullable text, column_default text)
language sql
security definer
set search_path = public, pg_catalog
as $$
  select c.column_name::text, c.data_type::text, c.is_nullable::text, c.column_default::text
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.table_name = p_table
   order by c.ordinal_position;
$$;

revoke all on function master_ai_describe_table(text) from public, anon, authenticated;
grant execute on function master_ai_describe_table(text) to service_role;

comment on function master_ai_describe_table(text) is
  'Column shape of a public table. Used by the Master AI runtime; service_role only.';;

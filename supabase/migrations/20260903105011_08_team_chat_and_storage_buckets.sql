-- ============================================================
-- AA Console · 08 · Team chat + Storage
-- Buckets are all private. Path convention puts the scoping id FIRST,
-- because storage RLS is written against the path prefix — that is
-- what makes "this employee, only their assigned clients" enforceable.
-- ============================================================

-- ---------- Team chat ----------
create table team_channels (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table team_messages (
  id         uuid primary key default gen_random_uuid(),
  channel_id uuid not null references team_channels(id) on delete cascade,
  author_id  uuid references profiles(id) on delete set null,
  body       text not null,
  created_at timestamptz not null default now()
);
create index tm_channel_idx on team_messages (channel_id, created_at);

alter table team_channels enable row level security;
alter table team_messages enable row level security;

create policy tc_admin_all on team_channels
  for all to authenticated using (is_admin()) with check (is_admin());
create policy tc_staff_read on team_channels
  for select to authenticated using (current_role_of() in ('admin','employee'));

create policy tmsg_staff_read on team_messages
  for select to authenticated using (current_role_of() in ('admin','employee'));
create policy tmsg_staff_insert on team_messages
  for insert to authenticated
  with check (current_role_of() in ('admin','employee') and author_id = auth.uid());
create policy tmsg_self_update on team_messages
  for update to authenticated using (author_id = auth.uid()) with check (author_id = auth.uid());

-- ---------- helper: tolerant uuid cast for path segments ----------
create or replace function try_uuid(t text)
returns uuid
language plpgsql
immutable
as $$
begin
  return t::uuid;
exception when others then
  return null;
end;
$$;

-- ============================================================
-- Buckets (all private; served through signed URLs)
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('sops',         'sops',         false, 52428800,  null),
  ('contracts',    'contracts',    false, 52428800,  null),
  ('client-media', 'client-media', false, 524288000, null),
  ('proof',        'proof',        false, 104857600, null)
on conflict (id) do nothing;

-- ---------- sops · {sop_id}/{filename} ----------
create policy sops_obj_admin_all on storage.objects
  for all to authenticated
  using (bucket_id = 'sops' and is_admin())
  with check (bucket_id = 'sops' and is_admin());
create policy sops_obj_staff_read on storage.objects
  for select to authenticated
  using (bucket_id = 'sops' and current_role_of() in ('admin','employee'));

-- ---------- contracts · {client_id}/{contract_id}/… ----------
create policy contracts_obj_admin_all on storage.objects
  for all to authenticated
  using (bucket_id = 'contracts' and is_admin())
  with check (bucket_id = 'contracts' and is_admin());
create policy contracts_obj_client_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'contracts'
    and exists (
      select 1 from client_users cu
       where cu.user_id = auth.uid()
         and cu.client_id = try_uuid((storage.foldername(name))[1])
    )
  );

-- ---------- client-media · {client_id}/{asset_id}.{ext} ----------
create policy media_obj_admin_all on storage.objects
  for all to authenticated
  using (bucket_id = 'client-media' and is_admin())
  with check (bucket_id = 'client-media' and is_admin());

-- an employee may upload only into a client folder they are assigned to
create policy media_obj_employee_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'client-media'
    and can_access_client(try_uuid((storage.foldername(name))[1]))
  );
create policy media_obj_employee_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'client-media'
    and owner = auth.uid()
  );
create policy media_obj_client_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'client-media'
    and exists (
      select 1 from client_users cu
       where cu.user_id = auth.uid()
         and cu.client_id = try_uuid((storage.foldername(name))[1])
    )
  );

-- ---------- proof · {client_id}/{proof_id}/… ----------
create policy proof_obj_admin_all on storage.objects
  for all to authenticated
  using (bucket_id = 'proof' and is_admin())
  with check (bucket_id = 'proof' and is_admin());
create policy proof_obj_client_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'proof'
    and can_access_client(try_uuid((storage.foldername(name))[1]))
  );
create policy proof_obj_client_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'proof'
    and can_access_client(try_uuid((storage.foldername(name))[1]))
  );;

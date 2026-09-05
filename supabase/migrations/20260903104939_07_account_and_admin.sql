-- ============================================================
-- AA Console · 07 · Client Account + Agency Admin
-- ============================================================

-- ---------- Onboarding ----------
create table client_onboarding_steps (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  step_key     text not null,
  title        text not null,
  status       step_status not null default 'pending',
  completed_by uuid references profiles(id) on delete set null,
  completed_at timestamptz,
  display_order integer not null default 0,
  created_at   timestamptz not null default now(),
  unique (client_id, step_key)
);
create index cos_client_idx on client_onboarding_steps (client_id, display_order);

-- The "Start" button. Seeds the checklist; safe to call twice.
create or replace function start_onboarding(p_client_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not can_access_client(p_client_id) then
    raise exception 'Not permitted for this client';
  end if;
  insert into client_onboarding_steps (client_id, step_key, title, display_order) values
    (p_client_id, 'onboarding_form',      'Onboarding Form',      1),
    (p_client_id, 'onboarding_call',      'Onboarding Call',      2),
    (p_client_id, 'credentials_collected','Credentials Collected',3)
  on conflict (client_id, step_key) do nothing;
end;
$$;

-- ---------- Integrations & Credentials ----------
-- The secret itself NEVER lands in this table. `credential_secret_id`
-- points at a Supabase Vault secret; the table holds only metadata.
create table client_integrations (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid not null references clients(id) on delete cascade,
  provider             text not null,
  credential_label     text,
  credential_secret_id uuid,            -- -> vault.secrets(id)
  access_level         text,
  status               text not null default 'connected',
  last_checked_at      timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (client_id, provider, credential_label)
);
create trigger cint_set_updated_at before update on client_integrations
  for each row execute function set_updated_at();
comment on column client_integrations.credential_secret_id is
  'Reference to a Supabase Vault secret. Never store a raw credential in this table.';

-- ---------- Contracts (file upload) ----------
create table client_contracts (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  title        text not null,
  storage_path text not null,
  signed_at    date,
  uploaded_by  uuid references profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index cc_client_idx on client_contracts (client_id, created_at desc);

-- ---------- Billing ----------
create table client_billing (
  client_id         uuid primary key references clients(id) on delete cascade,
  current_plan      text,
  monthly_amount    numeric(12,2),
  upsell_opportunity text,
  started_on        date,
  updated_at        timestamptz not null default now()
);
create trigger cbill_set_updated_at before update on client_billing
  for each row execute function set_updated_at();

-- Client Duration is derived, not entered.
create view client_billing_view as
select b.*,
       coalesce(b.started_on, c.created_at::date)                        as duration_from,
       (current_date - coalesce(b.started_on, c.created_at::date))       as duration_days
from client_billing b
join clients c on c.id = b.client_id;

-- ---------- Audit notes ----------
-- Deliberately named _notes: this is the manual account-review log
-- (Member / Date / Notes), not an automatic system audit trail.
create table client_audit_notes (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,
  member_id  uuid references team_members(id) on delete set null,
  note       text not null,
  noted_on   date not null default current_date,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index can_client_idx on client_audit_notes (client_id, noted_on desc);

-- ---------- SOPs (file upload, agency-wide) ----------
create table sops (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  owner_id     uuid references team_members(id) on delete set null,
  storage_path text not null,
  version      integer not null default 1,
  uploaded_by  uuid references profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger sops_set_updated_at before update on sops
  for each row execute function set_updated_at();

-- ---------- Financials ----------
-- The form collects line items and period figures; the statement
-- bodies and headline cards are read back out of these.
create table finance_periods (
  id         uuid primary key default gen_random_uuid(),
  period     date not null unique,           -- first day of the month
  mrr        numeric(14,2),
  cac        numeric(14,2),
  ltv        numeric(14,2),
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger fp_set_updated_at before update on finance_periods
  for each row execute function set_updated_at();

create table finance_entries (
  id            uuid primary key default gen_random_uuid(),
  period        date not null,
  statement     text not null,               -- income | balance | cash_flow
  category      text,
  line_item     text not null,
  amount        numeric(14,2) not null,
  client_id     uuid references clients(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index fe_period_idx on finance_entries (period, statement);

-- MRR computed from active billing, for reconciliation against the
-- figure entered on finance_periods.
create view mrr_from_billing as
select coalesce(sum(monthly_amount), 0) as mrr,
       count(*) filter (where monthly_amount > 0) as paying_clients
from client_billing;

-- ============================================================
-- RLS
-- ============================================================
alter table client_onboarding_steps enable row level security;
alter table client_integrations     enable row level security;
alter table client_contracts        enable row level security;
alter table client_billing          enable row level security;
alter table client_audit_notes      enable row level security;
alter table sops                    enable row level security;
alter table finance_periods         enable row level security;
alter table finance_entries         enable row level security;

create policy cos_admin_all on client_onboarding_steps
  for all to authenticated using (is_admin()) with check (is_admin());
create policy cos_scoped_read on client_onboarding_steps
  for select to authenticated using (can_access_client(client_id));
-- the client may tick off their own onboarding form
create policy cos_client_update on client_onboarding_steps
  for update to authenticated
  using (exists (select 1 from client_users cu
                  where cu.user_id = auth.uid() and cu.client_id = client_onboarding_steps.client_id))
  with check (true);

-- Integrations are ADMIN ONLY, including read. Credential metadata is
-- not something a client user or employee should enumerate.
create policy cint_admin_all on client_integrations
  for all to authenticated using (is_admin()) with check (is_admin());

create policy cc_admin_all on client_contracts
  for all to authenticated using (is_admin()) with check (is_admin());
create policy cc_client_read on client_contracts
  for select to authenticated
  using (exists (select 1 from client_users cu
                  where cu.user_id = auth.uid() and cu.client_id = client_contracts.client_id));

create policy cbill_admin_all on client_billing
  for all to authenticated using (is_admin()) with check (is_admin());
create policy cbill_client_read on client_billing
  for select to authenticated
  using (exists (select 1 from client_users cu
                  where cu.user_id = auth.uid() and cu.client_id = client_billing.client_id));

-- Audit notes are internal: admin only.
create policy can_admin_all on client_audit_notes
  for all to authenticated using (is_admin()) with check (is_admin());

-- SOPs: admins manage, staff read.
create policy sops_admin_all on sops
  for all to authenticated using (is_admin()) with check (is_admin());
create policy sops_staff_read on sops
  for select to authenticated using (current_role_of() in ('admin','employee'));

-- Finance is admin only.
create policy fp_admin_all on finance_periods
  for all to authenticated using (is_admin()) with check (is_admin());
create policy fe_admin_all on finance_entries
  for all to authenticated using (is_admin()) with check (is_admin());;

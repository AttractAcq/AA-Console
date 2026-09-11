-- Phase 10.1: the deployment layer that makes tool 2 publishable and tool 3
-- visitor-facing.
--
-- Three objects, deliberately not collapsed:
--   WEBSITE REPOSITORY        where AA can publish
--   CONVERSION PAGE           what AA publishes        (client_pages, exists)
--   SALES AGENT DEPLOYMENT    which approved agent operates on which page
--
-- The credential model matters and is easy to get wrong. The AA GitHub App's
-- private key is PLATFORM infrastructure: one key, held once, in the runtime's
-- deployment environment. It is deliberately NOT in client_integrations, whose
-- whole shape assumes a credential belongs to a client — duplicating one
-- platform key per client would multiply the blast radius of a leak by the
-- number of clients and make rotation impossible. What IS per-account is the
-- installation, and an installation id is not a secret.

-- A GitHub App installation. Not a secret: the id identifies an installation,
-- the private key that can act as it lives in the environment.
--
-- client_id is nullable on purpose. AA's own org installation serves the whole
-- estate and belongs to no single client; a client who later installs the same
-- App on their own org gets a row that names them. That is the handover path,
-- and it needs no schema change — only a second row.
create table github_app_installations (
  id              uuid primary key default gen_random_uuid(),
  installation_id bigint not null unique,
  account_login   text not null,
  account_type    text not null default 'Organization'
                    check (account_type in ('Organization', 'User')),
  client_id       uuid references clients (id) on delete set null,
  status          text not null default 'active'
                    check (status in ('active', 'suspended', 'revoked')),
  connected_at    timestamptz not null default now(),
  last_checked_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table github_app_installations is
  'Where the AA GitHub App is installed. Holds no secret — the App private key is one platform credential in the runtime environment, never per client. A nullable client_id is what makes a future client-owned installation a new row rather than a redesign.';
comment on column github_app_installations.client_id is
  'Null for AA''s own org installation, which serves the whole estate. Set when a client installs the App on their own account — the handover path.';

-- Where AA can publish for a client.
--
-- Bound to an installation rather than to a hard-coded owner, so moving a
-- client's site to their own GitHub account later changes one foreign key.
create table client_site_repositories (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid not null references clients (id) on delete cascade,
  installation_id      uuid not null references github_app_installations (id) on delete restrict,
  github_repository_id bigint,
  owner                text not null,
  repo                 text not null,
  default_branch       text not null default 'main',
  pages_path           text not null default '/'
                         check (pages_path in ('/', '/docs')),
  pages_url            text,
  custom_domain        text,
  status               text not null default 'provisioning'
                         check (status in ('provisioning', 'ready', 'failed', 'archived')),
  last_error           text,
  provisioned_at       timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (owner, repo)
);

create index client_site_repositories_client_idx on client_site_repositories (client_id, created_at desc);

comment on table client_site_repositories is
  'An AA-managed website repository. One repository hosts many pages.';
comment on column client_site_repositories.pages_path is
  'GitHub Pages branch-based publishing only accepts / or /docs as a source path, so the shell is laid out to suit rather than inventing a third option.';
comment on column client_site_repositories.installation_id is
  'Which installation can act on this repo. Re-pointing this is how a site moves to a client-owned account.';

-- Which approved agent operates on which page.
--
-- public_id is what the browser sees, and it is an identifier rather than a
-- credential: assume it is copied out of page source, because it will be.
-- Everything that makes it safe is enforced server-side — the deployment must
-- be enabled, its agent must be approved and live, and the request origin must
-- match allowed_origin.
create table client_sales_agent_deployments (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references clients (id) on delete cascade,
  sales_agent_id      uuid not null references client_sales_agents (id) on delete cascade,
  page_id             uuid not null references client_pages (id) on delete cascade,
  site_repository_id  uuid references client_site_repositories (id) on delete set null,

  public_id           text not null unique default encode(gen_random_bytes(16), 'hex'),
  allowed_origin      text not null,
  enabled             boolean not null default false,
  widget_config       jsonb not null default '{}'::jsonb,

  -- Limits live on the deployment so one page can be throttled or stopped
  -- without touching anything else.
  daily_message_limit integer not null default 500 check (daily_message_limit > 0),
  daily_cost_limit_usd numeric not null default 5.00 check (daily_cost_limit_usd >= 0),

  deployed_at         timestamptz,
  disabled_at         timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- One live agent per page for now. A partial unique index rather than a
-- constraint, so a page can keep its history of disabled deployments.
create unique index client_sales_agent_deployments_one_live
  on client_sales_agent_deployments (page_id) where enabled;
create index client_sales_agent_deployments_agent_idx
  on client_sales_agent_deployments (sales_agent_id);
create index client_sales_agent_deployments_client_idx
  on client_sales_agent_deployments (client_id, created_at desc);

comment on table client_sales_agent_deployments is
  'Which approved sales agent operates on which published page. One agent may be deployed to many pages; a page has at most one enabled deployment.';
comment on column client_sales_agent_deployments.public_id is
  'The only identifier the browser receives. An identifier, not authentication — assume it is copied from page source. Safety comes from enabled + agent approval + origin match, all checked server-side.';
comment on column client_sales_agent_deployments.allowed_origin is
  'The exact scheme+host this deployment may be called from. Drives Access-Control-Allow-Origin per deployment, because a static env allowlist cannot express one origin per client site.';

-- The live gate.
--
-- Tool 3 already has status draft/live/retired, so this does not invent a
-- parallel vocabulary — it adds the one fact that status cannot carry: that a
-- person read this agent and accepted it for public use. Being 'live' is an
-- intention; being approved is a signature.
alter table client_sales_agents
  add column approved_at timestamptz,
  add column approved_by uuid references profiles (id) on delete set null;

comment on column client_sales_agents.approved_at is
  'When a human approved this agent to speak to the public. Deployment requires both status = live and this being set, and the public runtime re-checks it on every request rather than trusting a hidden button.';

-- Which deployment a conversation came through.
alter table sales_agent_conversations
  add column deployment_id uuid references client_sales_agent_deployments (id) on delete set null;

comment on column sales_agent_conversations.deployment_id is
  'The deployment that produced this conversation, so a page can be judged separately from the agent script it ran.';

-- Every public request, for limits and for abuse forensics.
--
-- One append-only table serves per-IP throttling, the per-deployment daily
-- ceiling, the spend ceiling and the audit trail. Separate counters for each
-- would drift apart.
--
-- The IP is stored hashed. Rate limiting needs to recognise a repeat caller,
-- not to know who they are, and an un-hashed visitor IP on a marketing page is
-- personal data nobody here needs.
create table sales_runtime_requests (
  id             uuid primary key default gen_random_uuid(),
  deployment_id  uuid not null references client_sales_agent_deployments (id) on delete cascade,
  client_id      uuid not null references clients (id) on delete cascade,
  conversation_id uuid references sales_agent_conversations (id) on delete set null,
  ip_hash        text,
  origin         text,
  outcome        text not null
                   check (outcome in ('ok', 'rate_limited', 'ceiling', 'denied', 'error')),
  cost_usd       numeric not null default 0,
  occurred_at    timestamptz not null default now()
);

create index sales_runtime_requests_deployment_day_idx
  on sales_runtime_requests (deployment_id, occurred_at desc);
create index sales_runtime_requests_ip_idx
  on sales_runtime_requests (ip_hash, occurred_at desc) where ip_hash is not null;

comment on table sales_runtime_requests is
  'Every public sales-runtime request: the basis for per-IP throttling, the per-deployment daily ceiling, the spend ceiling and abuse forensics. IPs are hashed — throttling needs to recognise a repeat caller, not identify a person.';

-- What the runtime needs to serve one request, and nothing the browser may see.
--
-- service_role only. Returns null rather than raising when the deployment is
-- unusable, because a public endpoint must not tell a prober the difference
-- between "no such deployment", "disabled" and "agent not approved".
create or replace function resolve_sales_deployment(p_public_id text)
returns table (
  deployment_id   uuid,
  client_id       uuid,
  sales_agent_id  uuid,
  page_id         uuid,
  allowed_origin  text,
  widget_config   jsonb,
  daily_message_limit integer,
  daily_cost_limit_usd numeric,
  greeting        text,
  system_prompt   text,
  guardrails      text,
  booking_rule    text,
  escalation_rule text,
  qualification   jsonb,
  objections      jsonb
)
language sql
stable
security definer
set search_path to 'public'
as $$
  select d.id, d.client_id, d.sales_agent_id, d.page_id, d.allowed_origin, d.widget_config,
         d.daily_message_limit, d.daily_cost_limit_usd,
         a.greeting, a.system_prompt, a.guardrails, a.booking_rule, a.escalation_rule,
         a.qualification, a.objections
  from client_sales_agent_deployments d
  join client_sales_agents a on a.id = d.sales_agent_id
  where d.public_id = p_public_id
    and d.enabled
    -- Both halves of the live gate, re-checked here rather than trusted from
    -- whatever enabled the deployment.
    and a.status = 'live'
    and a.approved_at is not null
    and a.built_at is not null
    and auth.role() = 'service_role';
$$;

revoke execute on function resolve_sales_deployment(text) from public, anon, authenticated;
grant  execute on function resolve_sales_deployment(text) to service_role;

comment on function resolve_sales_deployment(text) is
  'Everything the public runtime needs for one request. service_role only — the prompt and guardrails must never reach a browser. Returns no row for a deployment that is missing, disabled, or whose agent is not approved and live, so a prober cannot tell those apart.';

-- May this request proceed?
--
-- Checked before any model call, because the point of a ceiling is to be
-- cheaper than the thing it is capping.
create or replace function sales_runtime_allow(
  p_deployment_id uuid,
  p_ip_hash       text,
  p_ip_per_minute integer default 12
)
returns table (allowed boolean, reason text)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  d          client_sales_agent_deployments%rowtype;
  v_today    integer;
  v_spend    numeric;
  v_ip_recent integer;
begin
  if auth.role() <> 'service_role' then
    raise exception 'service_role only';
  end if;

  select * into d from client_sales_agent_deployments
   where client_sales_agent_deployments.id = p_deployment_id;
  if d.id is null or not d.enabled then
    return query select false, 'deployment_unavailable'::text;
    return;
  end if;

  -- The UTC day, so a ceiling does not reset on the server's timezone.
  select count(*), coalesce(sum(cost_usd), 0)
    into v_today, v_spend
  from sales_runtime_requests r
  where r.deployment_id = p_deployment_id
    and r.outcome = 'ok'
    and r.occurred_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC');

  if v_today >= d.daily_message_limit then
    return query select false, 'daily_message_limit'::text;
    return;
  end if;
  if v_spend >= d.daily_cost_limit_usd then
    return query select false, 'daily_cost_limit'::text;
    return;
  end if;

  if p_ip_hash is not null then
    select count(*) into v_ip_recent
    from sales_runtime_requests r
    where r.ip_hash = p_ip_hash
      and r.occurred_at >= now() - interval '1 minute';
    if v_ip_recent >= greatest(1, p_ip_per_minute) then
      return query select false, 'ip_rate_limit'::text;
      return;
    end if;
  end if;

  return query select true, 'ok'::text;
end;
$$;

revoke execute on function sales_runtime_allow(uuid, text, integer) from public, anon, authenticated;
grant  execute on function sales_runtime_allow(uuid, text, integer) to service_role;

comment on function sales_runtime_allow(uuid, text, integer) is
  'Per-deployment daily message and spend ceilings plus a per-IP burst limit, all from sales_runtime_requests. Called before any model work, because a ceiling has to cost less than what it caps.';

alter table github_app_installations enable row level security;
alter table client_site_repositories enable row level security;
alter table client_sales_agent_deployments enable row level security;
alter table sales_runtime_requests enable row level security;

-- Installations are platform infrastructure: admins only, no client read.
create policy gai_admin_all on github_app_installations
  for all to authenticated using (is_admin()) with check (is_admin());

create policy csr_admin_all on client_site_repositories
  for all to authenticated using (is_admin()) with check (is_admin());
create policy csr_client_read on client_site_repositories
  for select to authenticated using (is_client_user(client_id));

create policy csad_admin_all on client_sales_agent_deployments
  for all to authenticated using (is_admin()) with check (is_admin());
create policy csad_client_read on client_sales_agent_deployments
  for select to authenticated using (is_client_user(client_id));

-- Request telemetry is admin-only. A client has no reason to read raw visitor
-- traffic, hashed or not, and the aggregate they care about is the conversation.
create policy srr_admin_read on sales_runtime_requests
  for select to authenticated using (is_admin());

-- Sales Agent Builder: the agent a client's own visitors talk to.
--
-- Tool 2 builds the page. This builds the thing standing on it. The console's
-- job is the same as it is for a page: aggregate everything the business knows
-- — offer strategy, ICP, brand voice, identity, cleared proof, and the page
-- the agent will live on — hand it to an agent behind one button, and then
-- SHOW what came back and where it is deployed.
--
-- What comes back is not HTML. A client-facing sales agent IS its operating
-- definition: how it opens, what it must find out, what it may never promise,
-- when it books and when it hands over to a person. So that is what this
-- table holds, in the shape a bot can revise one part of later.
--
-- The second half of this migration closes the hole tool 4 was left with:
-- "nothing writes a lead automatically". A conversation that produced a
-- contact becomes a lead here, attributed to the agent and the page that
-- caused it, which is what tool 7 then reads.

create table client_sales_agents (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients (id) on delete cascade,
  page_id     uuid references client_pages (id) on delete set null,
  name        text not null,
  purpose     text not null,
  status      text not null default 'draft'
                check (status in ('draft', 'live', 'retired')),

  -- Everything below is written by the agent, not by a person.
  greeting          text,
  system_prompt     text,
  qualification     jsonb not null default '[]'::jsonb,
  objections        jsonb not null default '[]'::jsonb,
  booking_rule      text,
  escalation_rule   text,
  guardrails        text,

  built_at    timestamptz,
  job_id      uuid references agent_jobs (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index client_sales_agents_client_idx on client_sales_agents (client_id, created_at desc);
create index client_sales_agents_page_idx on client_sales_agents (page_id) where page_id is not null;

comment on table client_sales_agents is
  'A client-facing sales, qualification and booking agent: the definition it runs on, built from the client''s own intelligence rather than written by hand.';
comment on column client_sales_agents.purpose is
  'The operator''s brief — what this agent is for. The only free text a person writes; everything else is generated from it plus the client''s intelligence.';
comment on column client_sales_agents.qualification is
  'Ordered [{question, why, good_answer, disqualifier}]. Structured rather than prose so a bot can revise one question without rewriting the agent.';
comment on column client_sales_agents.objections is
  'Ordered [{objection, response}]. Only objections the ICP actually raises, answered only with what the offer can back.';
comment on column client_sales_agents.guardrails is
  'What this agent may never say or promise, derived from the offer strategy''s stated limits. A sales agent that invents a claim is the client''s legal problem, not a copy problem.';
comment on column client_sales_agents.escalation_rule is
  'When to stop and hand to a person. An agent with no exit condition will keep talking through the one conversation that needed a human.';
comment on column client_sales_agents.status is
  'draft until someone has read it, live once it is answering visitors, retired when it is not. Deployment is a decision a person makes.';

-- A conversation the agent actually had.
--
-- Kept whether or not it produced anything: the conversations that went
-- nowhere are the ones that show which question is losing people, and they
-- are exactly the ones a system that only stored wins would throw away.
create table sales_agent_conversations (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients (id) on delete cascade,
  sales_agent_id  uuid not null references client_sales_agents (id) on delete cascade,
  page_id         uuid references client_pages (id) on delete set null,

  transcript      jsonb not null default '[]'::jsonb,
  contact_name    text,
  contact_email   text,
  contact_phone   text,
  qualified       boolean not null default false,
  outcome         text,
  handed_over     boolean not null default false,

  lead_id         uuid references client_leads (id) on delete set null,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz
);

create index sac_client_idx on sales_agent_conversations (client_id, started_at desc);
create index sac_agent_idx on sales_agent_conversations (sales_agent_id, started_at desc);

comment on table sales_agent_conversations is
  'Every conversation the agent had, including the ones that went nowhere — those are what show which question loses people.';
comment on column sales_agent_conversations.qualified is
  'Whether the agent judged this visitor a fit against its own qualification questions. A captured contact is not the same as a qualified one.';
comment on column sales_agent_conversations.lead_id is
  'Set once this conversation has been turned into a lead. Its presence is what makes capture idempotent.';

-- Where a lead came from, at agent granularity.
--
-- source_page_id already existed and still carries the page. This says which
-- agent on that page did the work, which is the only way to tell a good
-- qualification script from a good page.
alter table client_leads
  add column source_sales_agent_id uuid references client_sales_agents (id) on delete set null;

comment on column client_leads.source_sales_agent_id is
  'The sales agent whose conversation produced this lead. Distinct from source_page_id: the page earned the visit, the agent earned the contact.';

-- Turn a conversation into a lead, once.
--
-- Idempotent by construction: the conversation holds the lead it created, and
-- a second call returns that same lead rather than making another. A visitor
-- who refreshes and finishes the conversation twice is one person, and a
-- pipeline that says otherwise is worse than one that missed them.
create or replace function capture_sales_agent_lead(
  p_conversation_id uuid,
  p_opportunity_value numeric default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_conv   sales_agent_conversations%rowtype;
  v_lead   uuid;
  v_stage  lead_stage;
begin
  select * into v_conv from sales_agent_conversations where id = p_conversation_id;
  if v_conv.id is null then
    raise exception 'That conversation no longer exists.';
  end if;

  -- The runtime and the MCP gateway both reach this as service_role, and
  -- can_access_client has no service_role branch of its own.
  if not (auth.role() = 'service_role' or can_access_client(v_conv.client_id)) then
    raise exception 'Not permitted for this client';
  end if;

  -- Already captured. Return what exists rather than duplicating a person.
  if v_conv.lead_id is not null then
    return v_conv.lead_id;
  end if;

  -- A lead is a name someone can contact. Without a way to reach them there
  -- is nothing for Sales Ops to do, and a pipeline padded with unreachable
  -- rows stops being a measure of anything.
  if coalesce(trim(v_conv.contact_email), '') = ''
     and coalesce(trim(v_conv.contact_phone), '') = '' then
    raise exception 'That conversation captured no way to contact anyone.';
  end if;

  -- A conversation happened, by definition — that is what this table is. So
  -- the floor is 'conversation', never 'lead', and a fit judged by the agent
  -- lifts it one stage. Nothing here claims an appointment: booking is a
  -- separate event with its own outcome.
  v_stage := case when v_conv.qualified then 'qualified_conversation' else 'conversation' end;

  insert into client_leads (
    client_id, name, email, phone, source, source_channel,
    source_page_id, source_sales_agent_id,
    stage, stage_at, opportunity_value, notes
  )
  values (
    v_conv.client_id,
    nullif(trim(coalesce(v_conv.contact_name, '')), ''),
    nullif(trim(coalesce(v_conv.contact_email, '')), ''),
    nullif(trim(coalesce(v_conv.contact_phone, '')), ''),
    'sales_agent',
    'sales_agent',
    v_conv.page_id,
    v_conv.sales_agent_id,
    v_stage,
    now(),
    p_opportunity_value,
    nullif(trim(coalesce(v_conv.outcome, '')), '')
  )
  returning id into v_lead;

  update sales_agent_conversations set lead_id = v_lead where id = p_conversation_id;

  insert into lead_events (lead_id, client_id, kind, body, from_stage, to_stage, created_by)
  values (v_lead, v_conv.client_id, 'stage_change',
          'Captured from a sales agent conversation.', null, v_stage, auth.uid());

  return v_lead;
end;
$$;

revoke execute on function capture_sales_agent_lead(uuid, numeric) from public, anon;
grant  execute on function capture_sales_agent_lead(uuid, numeric) to authenticated, service_role;

comment on function capture_sales_agent_lead(uuid, numeric) is
  'Turns a sales agent conversation into a lead exactly once, attributed to both the page and the agent. Refuses a conversation with no way to contact anyone.';

alter table client_sales_agents enable row level security;
alter table sales_agent_conversations enable row level security;

create policy csa_admin_all on client_sales_agents
  for all to authenticated using (is_admin()) with check (is_admin());
create policy csa_client_read on client_sales_agents
  for select to authenticated using (is_client_user(client_id));

create policy sac_admin_all on sales_agent_conversations
  for all to authenticated using (is_admin()) with check (is_admin());
create policy sac_client_read on sales_agent_conversations
  for select to authenticated using (is_client_user(client_id));

insert into agents (agent_key, name, initials, domain, description, requires_upstream, requires_input)
values ('sales_agent', 'Sales Agent Builder', 'SA', 'conversion',
        'Builds a client-facing qualification and booking agent from the client''s offer, ICP, brand voice and cleared proof.',
        '{offer_strategy,icp}', true)
on conflict (agent_key) do nothing;

-- Revenue Pipeline OS: the chain from a name to cash collected.
--
-- client_leads held a name, a contact and a three-step touch model
-- (first_touch, second_touch, call_booked). That is a contact list with a
-- status field. The tool needs the acquisition chain AA actually runs on, and
-- it needs to answer questions a contact list cannot: who owns this, what is
-- the next action, what is it worth, and — the one everything downstream
-- depends on — where did it come from.
--
-- A new enum rather than values added to pipeline_stage. The old three do not
-- map onto the chain, mapping them would be guesswork, and the table holds no
-- rows so there is nothing to preserve. It also sidesteps the rule that
-- ALTER TYPE ... ADD VALUE cannot be used in the transaction that adds it.
--
-- ATTENTION is deliberately not a stage. Attention is impressions and reach,
-- which live in metrics_daily against a post; a lead begins when attention
-- becomes a name you can contact. Modelling attention here would double-count
-- it and put a number in the pipeline that no one can act on.

create type lead_stage as enum (
  'lead',
  'conversation',
  'qualified_conversation',
  'appointment',
  'qualified_appointment',
  'shown',
  'sale',
  'cash',
  'lost'
);

alter table client_leads
  -- who they are
  add column email  text,
  add column phone  text,

  -- where they are in the chain
  add column stage        lead_stage not null default 'lead',
  add column stage_at     timestamptz not null default now(),
  add column lost_reason  text,

  -- who is on it and what happens next. The pair that makes the pipeline
  -- operable rather than merely observable.
  add column owner_member_id  uuid references team_members(id) on delete set null,
  add column next_action      text,
  add column next_action_due  date,

  -- what it is worth, at each point it becomes knowable
  add column opportunity_value numeric(12,2),
  add column sale_value        numeric(12,2),
  add column cash_collected    numeric(12,2),

  -- the appointment, which is its own small lifecycle
  add column appointment_at      timestamptz,
  add column appointment_outcome text,

  -- why this lead exists. Without these, revenue can never be traced back to
  -- the asset, page or campaign that produced it, and the Iteration Engine has
  -- nothing to learn from.
  add column source_channel     text,
  add column source_page_id     uuid references client_pages(id)        on delete set null,
  add column source_asset_id    uuid references client_media_assets(id) on delete set null,
  add column source_post_id     uuid references scheduled_posts(id)     on delete set null,
  add column source_campaign_id uuid references campaigns(id)           on delete set null,

  add constraint lead_lost_has_reason
    check (stage <> 'lost' or lost_reason is not null),
  add constraint lead_appointment_outcome_known
    check (appointment_outcome is null
           or appointment_outcome in ('scheduled','showed','no_show','rescheduled','cancelled'));

comment on column client_leads.stage is
  'Where this lead is in the acquisition chain. Attention is not a stage: it is impressions against a post, and a lead begins when attention becomes a name.';
comment on column client_leads.next_action is
  'The single next thing someone must do. A lead in a stage with no next action is stalled, whatever the stage says.';
comment on column client_leads.source_post_id is
  'The post that produced this lead. This column, and its siblings, are what let revenue be traced back to the content that caused it.';

create index cl_stage_idx  on client_leads (client_id, stage, next_action_due);
create index cl_owner_idx  on client_leads (owner_member_id) where owner_member_id is not null;
create index cl_source_idx on client_leads (source_post_id)  where source_post_id is not null;

-- Everything that has happened to a lead, in order.
--
-- Conversation tracking without a timeline is a notes field that people
-- overwrite. Stage changes are recorded here too, so "how long did this sit in
-- qualified_conversation" is answerable later.
create table lead_events (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references client_leads(id) on delete cascade,
  client_id   uuid not null references clients(id) on delete cascade,
  kind        text not null check (kind in ('note','conversation','stage_change','appointment','outcome')),
  body        text,
  from_stage  lead_stage,
  to_stage    lead_stage,
  occurred_at timestamptz not null default now(),
  created_by  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index lead_events_lead_idx on lead_events (lead_id, occurred_at desc);

alter table lead_events enable row level security;

create policy le_admin_all on lead_events
  for all to authenticated using (is_admin()) with check (is_admin());
create policy le_client_read on lead_events
  for select to authenticated using (is_client_user(client_id));

comment on table lead_events is
  'Everything that has happened to a lead, in order, including stage changes — so time-in-stage is answerable rather than lost to an overwritten notes field.';

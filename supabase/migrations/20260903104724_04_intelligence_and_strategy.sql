-- ============================================================
-- AA Console · 04 · Intelligence & Strategy (per client)
--
-- Business Context is the one DIRECT surface: what is typed is what
-- renders. Everything else here is the agent triad —
--   client_agent_inputs  (the form)
--   agent_jobs           (the queue, migration 03)
--   client_agent_records (what the page renders)
--
-- Intelligence and Strategy share ONE records table rather than
-- getting a copy each. v5 shipped three parallel implementations of
-- this same pattern across ~2,300 lines; this is the unification.
-- ============================================================

create type record_domain as enum (
  'icp','competitor','association','market','campaign_intel',
  'brand_strategy','offer_strategy','money_model'
);

-- ---------- 1 · Business Context (DIRECT, the root) ----------
create table client_business_context (
  client_id          uuid primary key references clients(id) on delete cascade,
  business_overview  text,
  current_revenue    text,
  target_revenue     text,
  current_marketing  text,
  ideal_customer     text,
  main_offer         text,
  competitors        text,
  proof_testimonials text,
  -- carried over from v5's client_inputs: downstream agents use both
  -- and there is nowhere else for them to come from
  sales_process      text,
  brand_voice        text,
  updated_by         uuid references profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create trigger cbc_set_updated_at before update on client_business_context
  for each row execute function set_updated_at();

-- ---------- 2 · agent inputs (the form target) ----------
create table client_agent_inputs (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id) on delete cascade,
  domain      record_domain not null,
  payload     jsonb not null default '{}'::jsonb,
  notes       text,
  created_by  uuid references profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index cai_client_domain_idx on client_agent_inputs (client_id, domain, created_at desc);

-- ---------- 3 · agent records (what the UI renders) ----------
create table client_agent_records (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references clients(id) on delete cascade,
  domain         record_domain not null,
  job_id         uuid references agent_jobs(id) on delete set null,
  item_key       text not null,
  item_type      text not null default 'section',   -- 'core' | 'question' | 'section'
  title          text not null,
  body           text,
  -- campaign intelligence is the one domain with a period; '2026-Q1'
  period         text,
  display_order  integer not null default 0,
  status         record_status not null default 'draft',
  -- a human edit must survive an agent re-run
  edited_by      uuid references profiles(id) on delete set null,
  edited_at      timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (client_id, domain, item_key, period)
);
create trigger car_set_updated_at before update on client_agent_records
  for each row execute function set_updated_at();
create index car_client_domain_idx on client_agent_records (client_id, domain, display_order);
create index car_job_idx on client_agent_records (job_id);

-- Stamp edited_by/edited_at whenever a human changes a body.
create or replace function mark_record_edited()
returns trigger
language plpgsql
as $$
begin
  if new.body is distinct from old.body and auth.uid() is not null then
    new.edited_by = auth.uid();
    new.edited_at = now();
  end if;
  return new;
end;
$$;
create trigger car_mark_edited before update on client_agent_records
  for each row execute function mark_record_edited();

-- ---------- 4 · record templates ----------
-- The expected shape of each domain, independent of any client. The UI
-- renders these as the labelled empty-state cards it already has in
-- src/data/icp.ts, then fills bodies in from client_agent_records.
create table record_templates (
  domain         record_domain not null,
  item_key       text not null,
  item_type      text not null default 'section',
  title          text not null,
  description    text,
  display_order  integer not null default 0,
  primary key (domain, item_key)
);

insert into record_templates (domain, item_key, item_type, title, description, display_order) values
  -- ICP · 15 items, keys match src/data/icp.ts
  ('icp','avatar-role-map','core','Avatar role map','Buyer roles and segments',1),
  ('icp','visual-identity','core','Visual identity','Visible commercial and lifestyle cues',2),
  ('icp','social-circle','core','Social circle','Peers, validators, communities and influence groups',3),
  ('icp','status-markers','core','Status markers','Signals of progress, credibility, taste and aspiration',4),
  ('icp','daily-environment','core','Daily environment','Routines, constraints, places, pressures and tools',5),
  ('icp','trusted-advisors','core','Trusted advisors','People and proof sources trusted before decisions',6),
  ('icp','objections','core','Objections','Doubts, delay reasons, barriers and category fatigue',7),
  ('icp','purchase-trigger','core','Purchase trigger','Events that move the buyer into active consideration',8),
  ('icp','language-patterns','core','Language patterns','How buyers describe problems, goals, risks and alternatives',9),
  ('icp','desired-outcomes','core','Desired outcomes','Concrete and emotional definitions of success',10),
  ('icp','risk-and-fears','core','Risk and fears','Regret, exposure, switching anxiety and downside scenarios',11),
  ('icp','attention-channels','core','Attention channels','Where buyers search, learn, compare and validate claims',12),
  ('icp','decision-criteria','core','Decision criteria','Comparison logic, must-haves, disqualifiers and trade-offs',13),
  ('icp','question-universe','question','Question universe','Questions buyers ask across awareness, objections and decisions',14),
  ('icp','buyer-role-system','core','Buyer role system','Legacy or unscheduled Avatar Intelligence module',15),

  -- Competitors · 6
  ('competitor','positioning-category-map','section','Positioning and category map',null,1),
  ('competitor','offer-commercial-objectives','section','Offer and commercial objectives',null,2),
  ('competitor','messaging-claims','section','Messaging and claims',null,3),
  ('competitor','proof-trust-observations','section','Proof and trust observations',null,4),
  ('competitor','distribution-attention','section','Distribution and attention observations',null,5),
  ('competitor','landscape-patterns','section','Competitive landscape patterns',null,6),

  -- Branding & Associations · 6
  ('association','association-map','section','Positive and negative association map',null,1),
  ('association','trust-credibility','section','Trust and credibility signals',null,2),
  ('association','proof-authority','section','Proof and authority ecosystem',null,3),
  ('association','emotional-symbolic-cues','section','Emotional, symbolic and language cues',null,4),
  ('association','buyer-role-variation','section','Buyer-role and segment variation',null,5),
  ('association','tensions-unknowns','section','Tensions, cautions and unknowns',null,6),

  -- Campaign Intelligence · 4 quarters
  ('campaign_intel','q1','section','Quarter 1',null,1),
  ('campaign_intel','q2','section','Quarter 2',null,2),
  ('campaign_intel','q3','section','Quarter 3',null,3),
  ('campaign_intel','q4','section','Quarter 4',null,4),

  -- Branding Strategy · 3
  ('brand_strategy','cross-os-synthesis','section','Cross-OS Synthesis',null,1),
  ('brand_strategy','strategic-recommendations','section','Strategic Recommendations',null,2),
  ('brand_strategy','recommended-portfolio','section','Recommended Portfolio',null,3),

  -- Offer Strategy · 11
  ('offer_strategy','dream-outcome','section','Dream Outcome','Value equation',1),
  ('offer_strategy','likelihood','section','Likelihood of Achievement','Value equation',2),
  ('offer_strategy','time-delay','section','Time Delay','Value equation',3),
  ('offer_strategy','effort-sacrifice','section','Effort and Sacrifice','Value equation',4),
  ('offer_strategy','guarantee','section','Guarantee',null,5),
  ('offer_strategy','bonus-1','section','Bonus 1',null,6),
  ('offer_strategy','bonus-2','section','Bonus 2',null,7),
  ('offer_strategy','bonus-3','section','Bonus 3',null,8),
  ('offer_strategy','bonus-4','section','Bonus 4',null,9),
  ('offer_strategy','scarcity','section','Scarcity',null,10),
  ('offer_strategy','urgency','section','Urgency',null,11),

  -- Money Model · 5
  ('money_model','model','section','Model',null,1),
  ('money_model','attraction-offer','section','Attraction Offer',null,2),
  ('money_model','continuity-offer','section','Continuity Offer',null,3),
  ('money_model','upsell-offer','section','Upsell Offer',null,4),
  ('money_model','downsell-offer','section','Downsell Offer',null,5);

-- ============================================================
-- RLS
-- ============================================================
alter table client_business_context enable row level security;
alter table client_agent_inputs     enable row level security;
alter table client_agent_records    enable row level security;
alter table record_templates        enable row level security;

create policy cbc_admin_all on client_business_context
  for all to authenticated using (is_admin()) with check (is_admin());
create policy cbc_scoped_read on client_business_context
  for select to authenticated using (can_access_client(client_id));

create policy cai_admin_all on client_agent_inputs
  for all to authenticated using (is_admin()) with check (is_admin());
create policy cai_scoped_read on client_agent_inputs
  for select to authenticated using (can_access_client(client_id));

create policy car_admin_all on client_agent_records
  for all to authenticated using (is_admin()) with check (is_admin());
create policy car_scoped_read on client_agent_records
  for select to authenticated using (can_access_client(client_id));

create policy record_templates_read on record_templates
  for select to authenticated using (true);
create policy record_templates_admin_all on record_templates
  for all to authenticated using (is_admin()) with check (is_admin());;

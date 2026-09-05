-- ============================================================
-- AA Console · 27 · The core questions become the spec
--
-- Each module now has a template per core question, with the question
-- itself as the description. That is load-bearing rather than
-- documentation: buildSubmitTool() puts every description into the submit
-- schema, and the factory puts them into the prompt's section brief — so
-- the questions reach the agents automatically, and adding a question
-- later needs no code change.
-- ============================================================

-- ---------- 1 · MARKET (new tab; was dropped in the AA Console redesign) ----------
-- Ported from v5's Market OS five modules, sharpened onto the three
-- questions that actually matter commercially.
insert into record_templates (domain, item_key, item_type, title, description, display_order) values
  ('market','market-definition','section','Market definition and boundaries',
   'What market is this business actually in? Category, geography, adjacent categories, and what is explicitly out of scope.',1),
  ('market','market-size-and-share','section','Market size and share needed',
   'How big is the market, and how much of it does this business need? Give the reachable market, then the share required to hit their stated target revenue. State units, geography and assumptions. Do not confuse obtainable market with media-reachable audience.',2),
  ('market','market-direction','section','Market direction',
   'Is the market getting bigger or smaller? Evidence for growth or decline, and what is driving it.',3),
  ('market','constraint-diagnosis','section','Supply or demand constrained',
   'Is this business supply-constrained or demand-constrained? Say which, and what the evidence is. This determines whether marketing spend or capacity is the bottleneck, so be decisive rather than balanced.',4),
  ('market','commercial-structure','section','Commercial structure and constraints',
   'How value and money move through this market: routes to market, business models, category economics, plus regulation and structural barriers that shape what is possible.',5)
on conflict (domain, item_key) do update
  set title = excluded.title, description = excluded.description, display_order = excluded.display_order;

-- ---------- 5 · PROOF INTELLIGENCE (new tab) ----------
-- Distinct from the Proof Bank: the Bank stores proof assets, this
-- assesses what proof exists, what is unique, and what could become proof.
insert into record_templates (domain, item_key, item_type, title, description, display_order) values
  ('proof','proof-differentiators','section','Proof that differentiates us',
   'What proof does this business currently have that genuinely differentiates it from the market? Only proof that actually exists — name it specifically.',1),
  ('proof','unique-capabilities','section','What makes this business unique',
   'What speed, skills, trades, views or ideas make this business unique? The things a competitor could not simply copy.',2),
  ('proof','daily-proof-opportunities','section','Daily work that could become proof',
   'What does this business do on a daily basis that could be captured and turned into proof? Be specific and practical — things a phone could record this week.',3),
  ('proof','proof-of-work','section','Proof of work',
   'What proof of work can be shown to the ICP? Evidence the business does the thing well: process, craft, before and after, the work itself.',4),
  ('proof','proof-of-concept','section','Proof of concept',
   'What proof of concept can be shown to the ICP? Evidence the approach works: outcomes, results, third-party validation, worked examples.',5)
on conflict (domain, item_key) do update
  set title = excluded.title, description = excluded.description, display_order = excluded.display_order;

-- ---------- 2 · ICP — the gaps ----------
insert into record_templates (domain, item_key, item_type, title, description, display_order) values
  ('icp','demographic-profile','core','Demographic',
   'What is their demographic? Age, income, life stage, household, occupation — only what is actually knowable, and say what is not.',16),
  ('icp','identity-and-beliefs','core','Identity, interests and beliefs',
   'What do these people identify themselves AS? What are their interests and what do they believe? Identity drives more buying behaviour than demographics.',17),
  ('icp','core-pain','core','Biggest underlying pain',
   'What is the single biggest underlying pain this person is trying to solve? Not the surface complaint — the thing underneath it.',18),
  ('icp','attention-offline','core','Attention in real life',
   'Where is this person''s attention in real life? Physical places, routines, events, communities, media consumed away from a screen.',19),
  ('icp','social-media-habits','core','Social media behaviour',
   'Where is their attention on social media, and where AND WHEN do they actually use it? Platforms, times of day, and what mode they are in when they open each one.',20),
  ('icp','emotional-triggers','core','Emotional triggers',
   'What invokes a fundamentally negative emotion in this person, and what invokes a fundamentally positive one? Go below the commercial surface to what actually moves them.',21),
  ('icp','location-and-decision-maker','core','Location and the real decision maker',
   'Where do these people live, and who is the REAL decision maker? Name the person who actually signs off, which is often not the person who enquires.',22)
on conflict (domain, item_key) do update
  set title = excluded.title, description = excluded.description, display_order = excluded.display_order;

-- Two existing ICP sections had to widen to carry their question fully.
update record_templates
   set description = 'Comparison logic, must-haves, disqualifiers and trade-offs — and HOW FAST they decide. Name the typical time from first enquiry to committing, and what stretches or shortens it.'
 where domain = 'icp' and item_key = 'decision-criteria';
update record_templates
   set description = 'Where buyers search, learn, compare and validate claims ONLINE. Physical attention is covered separately by "Attention in real life".'
 where domain = 'icp' and item_key = 'attention-channels';

-- ---------- 3 · COMPETITOR — the gaps ----------
insert into record_templates (domain, item_key, item_type, title, description, display_order) values
  ('competitor','brand-salience','section','Has anyone built a name',
   'Has anybody in this market actually built a name? Name who has real brand recognition versus who is merely present, and what earned it.',7),
  ('competitor','marketing-strengths-and-gaps','section','What competitors do well, and what they miss',
   'What marketing do the competitors do well, and what are they missing? Be specific about the gap — an unserved question, an unclaimed format, an audience nobody speaks to.',8),
  ('competitor','price-positioning','section','Pricing relative to this business',
   'Where does this business sit on price relative to competitors, as far as is publicly observable? Say plainly where pricing is not published rather than estimating it.',9),
  ('competitor','differentiation-openings','section','Openings to differentiate',
   'Where could this business differentiate? Name the OPENINGS the evidence reveals — gaps nobody occupies. Describe the opening, not the campaign; choosing which to take is Brand Strategy''s job.',10)
on conflict (domain, item_key) do update
  set title = excluded.title, description = excluded.description, display_order = excluded.display_order;

-- ---------- 4 · CAMPAIGN — cross-year analysis before the quarters ----------
-- The quarters shift down so the three analytical sections that inform
-- them come first.
update record_templates set display_order = display_order + 3
 where domain = 'campaign_intel' and item_key in ('q1','q2','q3','q4');

insert into record_templates (domain, item_key, item_type, title, description, display_order) values
  ('campaign_intel','buying-seasonality','section','When customers are most willing to buy',
   'During what times of the year are these customers most willing to buy, and why? Anchor to something real — their cash cycle, their industry, weather, school terms, tax dates.',1),
  ('campaign_intel','annual-themes','section','Recurring annual themes',
   'What recurring themes happen each year across this market? The predictable conversations, events and pressures that come round annually.',2),
  ('campaign_intel','emotional-calendar','section','Emotional state through the year',
   'How does the emotional state of this ICP fluctuate through the year? When are they optimistic, stretched, reflective, or avoidant — and what does that mean for what will land.',3)
on conflict (domain, item_key) do update
  set title = excluded.title, description = excluded.description, display_order = excluded.display_order;

-- ---------- register the proof agent, unblock market ----------
insert into agents (agent_key, name, initials, domain, description, requires_upstream) values
  ('proof','Proof Intelligence','PR','intelligence',
   'Assesses what proof this business has, what makes it unique, and what daily work could become proof.','{}')
on conflict (agent_key) do update set description = excluded.description;

-- Market has templates and a tab now, so the reason it was paused is gone.
update agents
   set paused = false,
       archived_at = null,
       description = 'Category, size, direction, and whether the business is supply- or demand-constrained.'
 where agent_key = 'market';;

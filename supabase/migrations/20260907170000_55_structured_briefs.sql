-- Brief Studio: make a brief a structure, not a wall of prose.
--
-- client_briefs held a title and one markdown body. That is readable by a
-- person and opaque to everything else. The Content Production OS needs the
-- brief to be the place production decisions live, and the Iteration Engine
-- needs them as fields specifically: its promise is that "hook X + offer Y +
-- format Z works", and you cannot learn which hook worked when the hook is a
-- sentence somewhere inside a markdown blob.
--
-- `body` is kept, not replaced. It stays the thing an editor actually reads,
-- and it is now COMPOSED from these fields by the agent rather than written
-- separately, so the prose and the structure cannot drift apart. The five
-- briefs that predate this keep their prose and carry null fields.

alter table client_briefs
  add column hook              text,
  add column premise           text,
  add column argument          text,
  add column proof             text,
  add column proof_asset_id    uuid references client_proof_assets(id) on delete set null,
  add column script            text,
  add column visual_direction  text,
  add column shot_requirements text,
  add column b_roll            text,
  add column call_to_action    text,
  add column channel_intent    text,
  add column production_method text;

comment on column client_briefs.hook is
  'The first thing the audience sees or hears. The field the Iteration Engine learns against.';
comment on column client_briefs.premise is
  'The idea restated in one line, so a maker knows what they are actually saying.';
comment on column client_briefs.argument is
  'How the piece earns the claim: the reasoning, in order.';
comment on column client_briefs.proof is
  'The specific proof point this piece makes. Null means the piece must work without one — which is a decision, not an omission.';
comment on column client_briefs.proof_asset_id is
  'The proof record backing that point, once Proof & Asset OS structures them. Null while proof is only prose.';
comment on column client_briefs.script is
  'Spoken or written words for the maker. For an image brief this is the on-image copy.';
comment on column client_briefs.visual_direction is
  'How it should look. Distinct from the brand profile, which says how the client always looks.';
comment on column client_briefs.shot_requirements is
  'Video only. Null on an image or text brief is correct, not missing.';
comment on column client_briefs.b_roll is
  'Video only. Null on an image or text brief is correct, not missing.';
comment on column client_briefs.call_to_action is
  'The action asked for. Paired with hook in what the Iteration Engine learns.';
comment on column client_briefs.channel_intent is
  'Where this is meant to run. Shapes aspect, length and register.';
comment on column client_briefs.production_method is
  'Who or what makes it. Written by the Production Router when a brief is approved and built.';

create index client_briefs_client_idx on client_briefs (client_id, created_at desc);

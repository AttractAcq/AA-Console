-- The campaign template a campaign is built from.
--
-- client_campaigns.objective is free text, and the planner wrote a fresh
-- sentence into it every time. Prose cannot be checked, cannot be sequenced,
-- and cannot be turned into a Meta campaign: "grow awareness among local
-- families" names no objective the Marketing API accepts and no event it can
-- optimise for.
--
-- These columns hold the machinery; objective keeps holding the prose, which
-- is still worth having for whoever reads the campaign. The sixteen codes are
-- the library in agent-runtime/src/campaigns/templates.ts and the Paid
-- Campaign Matrix. Codes are stable — renaming one is another migration.
--
-- Every column is nullable. Campaigns already on file were planned before the
-- library existed and there is no honest way to backfill what template they
-- would have used; a guess here would be indistinguishable from a decision
-- somebody made.

create type campaign_template as enum (
  'P1', 'P2', 'P3', 'P4', 'P5',
  'R1', 'R2', 'R3', 'R4',
  'C1', 'C2', 'C3',
  'O1', 'O2',
  'X1', 'X2'
);

create type audience_state as enum ('S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6');

alter table client_campaigns
  add column template           campaign_template,
  add column entry_state        audience_state,
  add column exit_state         audience_state,
  add column optimisation_event text,
  -- X1 and X2 have no objective of their own; they take one from the template
  -- they scale or test. A mirror with nothing to mirror is broad targeting.
  add column mirrors_template   campaign_template,
  add constraint client_campaigns_mirror_is_not_self
    check (mirrors_template is null or mirrors_template <> template),
  add constraint client_campaigns_mirror_only_for_mirroring_templates
    check (mirrors_template is null or template in ('X1', 'X2'));

create index client_campaigns_template_idx
  on client_campaigns (template, created_at desc)
  where template is not null;

comment on column client_campaigns.template is
  'Which of the sixteen campaign templates this is built from. Null on campaigns planned before the library existed.';
comment on column client_campaigns.entry_state is
  'The audience state this campaign takes people from (S0 stranger to S6 lapsed).';
comment on column client_campaigns.exit_state is
  'The audience state it moves them to. Entry and exit together say whether the campaign builds a pool or spends one.';
comment on column client_campaigns.optimisation_event is
  'What the ad set optimises for, kept separate from the objective. This is the field that decides who Meta shows the ad to, and picking the cheap event is how an account fills with leads nobody can sell to.';
comment on column client_campaigns.mirrors_template is
  'For X1 and X2 only: the template whose objective, event and CTA this one inherits.';

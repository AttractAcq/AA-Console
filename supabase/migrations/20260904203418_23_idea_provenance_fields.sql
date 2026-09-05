-- ============================================================
-- AA Console · 23 · Idea provenance
--
-- The v5 ideation architecture's minimal idea object carries more than a
-- title and a body. Three of its fields earn a column because something
-- downstream reads them:
--
--   content_territory  groups the bank, and is what Brand Strategy said
--                      this business should own
--   source_question    the link back to the ICP question universe — the
--                      architecture's rule is that ideation CONSUMES that
--                      universe and never reconstructs it, and this column
--                      is how you audit whether it obeyed
--   strategic_reason   why this is worth saying, so a human selecting 20
--                      of 100 has something to select on
--
-- audience is deliberately not a column: it is the ICP, identical across
-- every idea in a run, and belongs in the record it came from.
-- ============================================================

alter table client_ideas add column if not exists content_territory text;
alter table client_ideas add column if not exists source_question   text;
alter table client_ideas add column if not exists strategic_reason  text;

create index if not exists client_ideas_territory_idx
  on client_ideas (client_id, content_territory);

comment on column client_ideas.source_question is
  'The ICP question or tension this idea answers. Ideation consumes the question universe rather than inventing one; this is the audit trail for that.';;

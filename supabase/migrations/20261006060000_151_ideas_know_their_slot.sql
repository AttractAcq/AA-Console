-- An idea the engine asked for knows which slot it was asked for.
--
-- M3.5. Ideation already records job_id, which is enough to trace an idea
-- back to the run that made it, but not enough for the selector (M3.6) to ask
-- the question it actually needs to ask: "what are the candidates for this
-- slot". Going via the job would mean finding the job whose params mention
-- the slot, which is a join through a jsonb field to answer a question that
-- is really about a foreign key.
--
-- Null for every idea that already exists and for every one a person asks
-- for by hand. A slot-driven run is a different thing from filling a bank,
-- and this column is what says which happened.

alter table client_ideas
  add column if not exists slot_id uuid references content_slots(id) on delete set null;

comment on column client_ideas.slot_id is
  'The slot this idea was generated for, when the engine asked for it. Null for ideas from an unscoped run or a person.';

-- The selector's only question: the candidates for one slot, newest first.
create index if not exists client_ideas_slot_idx
  on client_ideas (slot_id, created_at desc)
  where slot_id is not null;

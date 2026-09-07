-- Proof & Asset OS: proof as a record you can query, not a file you can find.
--
-- client_proof_assets held title, body and source. That is a filing cabinet.
-- AA's thesis is that proof becomes attention and demand, and every tool
-- downstream needs to ask one question — "what is the strongest usable proof
-- for this buyer and this claim?" — which a title and a paragraph cannot
-- answer.
--
-- The evidence that this was starving the rest of the system: the brief agent
-- ran this morning against two proof records and wrote "No proof point is
-- used, deliberately. The single item on file is a Google review." Three
-- briefs name a proof point in prose; none is linked to a proof record.
--
-- Usage rights default to not_cleared, deliberately. A customer result needs
-- permission before it appears in advertising, and the safe default for a
-- system that puts claims in front of the public is that nothing is usable
-- until a person says it is. That means the two existing records stop being
-- offered to agents until someone clears them, which is correct rather than
-- convenient.

alter table client_proof_assets
  add column ref_number       text,
  add column proof_type       text,
  add column claim            text,
  add column evidence         text,
  add column avatar_relevance text,
  add column services         text,
  add column strength         text not null default 'medium',
  add column usage_rights     text not null default 'not_cleared',
  add column captured_on      date,
  add column expires_on       date,
  add column updated_at       timestamptz not null default now();

alter table client_proof_assets
  add constraint proof_type_known check (
    proof_type is null or proof_type in (
      'customer_result','testimonial','review','case_study','before_after',
      'stat','credential','award','press','process','team_expertise','customer_story'
    )
  ),
  add constraint proof_strength_known check (strength in ('high','medium','low')),
  add constraint proof_rights_known   check (usage_rights in ('approved','restricted','not_cleared'));

comment on column client_proof_assets.claim is
  'The single specific thing this proof supports. "Completed a luxury renovation six weeks early", not "we are good at renovations".';
comment on column client_proof_assets.evidence is
  'What actually backs the claim, so a reader can judge it: documentation, a named testimonial, a measured figure.';
comment on column client_proof_assets.avatar_relevance is
  'Which buyer this lands with. The field that makes "strongest proof for this avatar" answerable.';
comment on column client_proof_assets.strength is
  'high | medium | low. How much weight this carries with a sceptical buyer, not how much we like it.';
comment on column client_proof_assets.usage_rights is
  'approved | restricted | not_cleared. Defaults to not_cleared: nothing reaches advertising until a person says it may.';
comment on column client_proof_assets.expires_on is
  'Proof goes stale. A result from four years ago is weaker than the same result last quarter, and some permissions lapse outright.';

-- Same per-client sequence as briefs, assets and posts, so one client's
-- artefacts read as one numbered set rather than several.
create trigger cpa_assign_ref before insert on client_proof_assets
  for each row execute function assign_ref_number();

create trigger cpa_set_updated_at before update on client_proof_assets
  for each row execute function set_updated_at();

update client_proof_assets set ref_number = next_ref_number(client_id) where ref_number is null;

create index cpa_usable_idx on client_proof_assets (client_id, usage_rights, strength);

-- The question every other tool asks.
--
-- Returns only proof a person has cleared and that has not expired, strongest
-- first. Avatar matching is a filter, not a ranking: relevance is a judgement
-- an agent makes from the claim, and pretending a LIKE is relevance would be
-- worse than handing over the shortlist.
create or replace function usable_proof(
  p_client_id uuid,
  p_avatar    text default null,
  p_limit     integer default 10
)
returns setof client_proof_assets
language sql
stable
security definer
set search_path = public
as $$
  select *
  from client_proof_assets p
  where p.client_id = p_client_id
    -- The runtime calls this as service_role, which has no auth.uid(), so
    -- can_access_client alone would return nothing to the agents that need it
    -- most. This is not a widening: service_role already reads the table
    -- directly with RLS bypassed. It is the same trap that produced the _as
    -- variants of enqueue_agent_job and start_master_run.
    and (auth.role() = 'service_role' or can_access_client(p_client_id))
    and p.usage_rights = 'approved'
    and (p.expires_on is null or p.expires_on >= current_date)
    and (p_avatar is null or p.avatar_relevance is null or p.avatar_relevance ilike '%' || p_avatar || '%')
  order by case p.strength when 'high' then 0 when 'medium' then 1 else 2 end,
           p.captured_on desc nulls last,
           p.created_at desc
  limit greatest(1, least(coalesce(p_limit, 10), 50));
$$;

revoke execute on function usable_proof(uuid, text, integer) from public, anon;
grant  execute on function usable_proof(uuid, text, integer) to authenticated, service_role;

comment on function usable_proof(uuid, text, integer) is
  'The strongest proof a client may actually use: cleared, unexpired, strongest first. The one question Proof & Asset OS exists to answer.';

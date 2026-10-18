-- The discovery agent.
--
-- `requires_upstream` is the point of this row. Discovery reads market, ICP,
-- association and competitor records and proposes buying situations from
-- them; run against a client with none, the best it could do is invent
-- plausible segments out of the business name, which is precisely the failure
-- this engine exists to avoid. The gate makes that impossible rather than
-- merely discouraged, and the runner refuses as well for the case where the
-- records exist but are empty.
--
-- Not registered against a record_domain: this agent does not write
-- client_agent_records. It writes market_opportunities, which is a different
-- kind of object with its own lifecycle, and giving it a domain would put it
-- on an Intelligence screen that cannot show what it produced.

insert into agents (agent_key, name, initials, domain, description, requires_upstream) values
  ('opportunity_discovery', 'Opportunity Discovery', 'OD', null,
   'Reads a client''s market, ICP, association and competitor intelligence and proposes the specific buying situations worth pursuing. Everything it proposes is a hypothesis until a person evidences it.',
   array['market', 'icp'])
on conflict (agent_key) do update
  set name = excluded.name,
      initials = excluded.initials,
      description = excluded.description,
      requires_upstream = excluded.requires_upstream;

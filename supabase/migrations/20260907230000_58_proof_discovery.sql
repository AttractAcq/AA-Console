-- Proof Finder: go and look for the proof that already exists online.
--
-- The Proof Bank assumed someone would type proof in. Most of a business's
-- proof is already published — Google and other review sites, directory
-- ratings, press, awards, case studies on their own site — and nobody at AA
-- has time to go and find it for every client.
--
-- This is a native agent rather than instructions for a bot to follow, because
-- the runtime already carries web search, and an agent that writes structured
-- records lands the result in the shape the rest of the system can query. A
-- bot following instructions would produce prose somebody then has to retype.
--
-- Everything it finds lands not_cleared, without exception. Finding a review
-- is not permission to put it in advertising, and the agent has no way to know
-- whether a customer agreed to be quoted. A person clears it.

insert into agents (agent_key, name, initials, domain, description, requires_upstream, requires_input)
values ('proof_discovery', 'Proof Finder', 'PF', 'content',
        'Searches the web for proof this business already has published, and files each find as a structured record awaiting clearance.',
        '{}', false)
on conflict (agent_key) do nothing;

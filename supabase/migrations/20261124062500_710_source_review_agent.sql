insert into public.agents (agent_key, name, initials, domain, description, requires_upstream, requires_input)
values ('source_review', 'Source Reviewer', 'SR', 'strategy',
  'Prepares evidence-based draft reviews for Intelligence and Strategy sections.',
  array[]::text[], false)
on conflict (agent_key) do nothing;

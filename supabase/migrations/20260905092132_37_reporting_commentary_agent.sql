-- The reporting commentary agent: the one place a model belongs in this
-- pipeline. It does not fetch or write a number — it reads what the ingest
-- already put in metrics_daily and says what it means.
--
-- The sections are the questions an operator actually gets asked in a
-- client meeting, in the order they get asked.

insert into record_templates (domain, item_key, item_type, title, description, display_order) values
  ('reporting', 'headline', 'section', 'Headline',
   'The one sentence you would open the client call with. What happened this period, in plain language, with the number that matters.', 1),

  ('reporting', 'what_moved', 'section', 'What moved',
   'The changes that are real, each with its figure and its direction. Distinguish a change big enough to act on from ordinary week-to-week noise, and say which is which.', 2),

  ('reporting', 'what_is_working', 'section', 'What is working',
   'The campaigns, posts or angles carrying the result, with the evidence. Name them specifically rather than describing a pattern.', 3),

  ('reporting', 'what_is_not', 'section', 'What is not working',
   'What is losing money or attention, with the figure that shows it, and whether it is worth fixing or worth stopping.', 4),

  ('reporting', 'efficiency', 'section', 'Cost and efficiency',
   'Cost per result and how it is trending. State the basis for every derived figure so it can be checked, and say when spend is too small for a rate to mean anything yet.', 5),

  ('reporting', 'recommendations', 'section', 'What to change',
   'The specific changes to make before the next period, in priority order. Each one must follow from a figure above, not from general marketing advice.', 6),

  ('reporting', 'gaps', 'section', 'What we could not see',
   'What is missing from the data and what it would take to answer it: an unmapped campaign, a surface with no integration, a window too short to judge. Say plainly when the honest answer is that it is too early to tell.', 7)
on conflict (domain, item_key) do update
  set title = excluded.title,
      description = excluded.description,
      display_order = excluded.display_order;

insert into agents (agent_key, name, initials, domain, description, requires_upstream)
values (
  'reporting',
  'Reporting Commentary',
  'RC',
  'intelligence',
  'Reads metrics_daily and writes the client-facing narrative: what moved, what it means, what to change. Never invents a figure - it only interprets numbers already ingested.',
  '{}'
)
on conflict (agent_key) do update
  set description = excluded.description;;

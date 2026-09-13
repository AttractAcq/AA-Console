-- Phase 10.9: register the polish loop.
--
-- These are registered and site_provision/page_publish are not, and the
-- difference is deliberate: these two can succeed today. An agent that can be
-- queued but cannot possibly finish is the creative_build/landing_page bug
-- again, where every master run produced two guaranteed failures for days.
--
-- requires_input is true because both act on one page a person chose. That also
-- keeps them out of master runs, which have no page to hand them.
--
-- requires_upstream is empty on purpose. A page can only be audited if it was
-- built, and it could only be built because the offer strategy already existed
-- — re-checking that here would add friction to prove something already proven.

insert into agents (agent_key, name, initials, domain, description, requires_upstream, requires_input)
values
  ('page_audit', 'Page Auditor', 'PA', 'conversion',
   'Reads a built page and reports what is wrong with it. Writes findings only — it cannot change the page.',
   '{}', true),
  ('page_revise', 'Page Reviser', 'PV', 'conversion',
   'Applies the findings a person selected and records a new page revision. Only ever sees findings an agent may safely act on.',
   '{}', true)
on conflict (agent_key) do nothing;

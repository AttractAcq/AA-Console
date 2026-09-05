-- Not every number on a given day means the same thing.
--
-- Paid insights come back per day: "this campaign spent this much on the
-- 3rd". Instagram media insights come back lifetime-to-date: "this post has
-- 4,100 impressions as at the 3rd". Both are legitimately one row per day,
-- but summing the second across a month is nonsense.
--
-- Putting that in the data rather than in a comment means a panel cannot
-- quietly add up cumulative rows: it has to filter on basis first.

create type metric_basis as enum ('daily', 'cumulative');

alter table metrics_daily
  add column basis metric_basis not null default 'daily',
  -- Spend is meaningless without it, and ad accounts are not all in one.
  add column currency text;

comment on column metrics_daily.basis is
  'daily = the value for that date alone (sum across dates). cumulative = lifetime-to-date as at that date (take the latest, or diff consecutive days).';
comment on column metrics_daily.currency is
  'ISO code for spend, from the upstream ad account. Null where the row carries no money.';;

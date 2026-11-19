-- New spend rows must state their actual currency. The old ZAR default was an
-- assumption, not evidence, and could silently mislabel an imported amount.
-- NOT VALID preserves historical rows while enforcing every new insert/update;
-- legacy currency provenance needs a separate audited review.
alter table public.client_marketing_spend
  alter column currency drop default;

alter table public.client_marketing_spend
  add constraint client_marketing_spend_currency_code_v6
  check (currency ~ '^[A-Z]{3}$') not valid;

comment on column public.client_marketing_spend.currency is
  'Explicit three-letter currency code recorded with spend. No default or conversion is applied; historical ZAR rows created under the former default require provenance review.';

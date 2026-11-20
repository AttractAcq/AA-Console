-- The lead identity persists after a lead moves into archived_leads. A
-- submission's promoted lead link must persist too, or its exact capture
-- route is lost when archive_lead deletes the active lead row.
begin;
do $$ begin
  if exists (
    select 1 from public.lead_submissions s
    left join public.lead_identities i on i.id=s.lead_id and i.client_id=s.client_id
    where s.lead_id is not null and i.id is null
  ) then
    raise exception 'A promoted submission has no same-client durable lead identity.'
      using errcode='23503';
  end if;
end $$;
alter table public.lead_submissions
  drop constraint lead_submissions_lead_id_fkey;
alter table public.lead_submissions
  add constraint lead_submissions_lead_identity_fkey
  foreign key (lead_id,client_id)
  references public.lead_identities(id,client_id) on delete cascade;
comment on column public.lead_submissions.lead_id is
  'Durable promoted lead identity. Survives removal of the active client_leads row during archiving so capture-route lineage remains readable.';
commit;

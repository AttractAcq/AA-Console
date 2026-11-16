-- Keep captured reviews tied to their changing third-party source. A changed or
-- removed review invalidates its exact rights decision and downstream placements.
begin;
alter table public.client_proof_assets
  add column google_source_changed_at timestamptz;

create function public.sync_google_review_proof_source_v7()
returns trigger language plpgsql volatile security definer
set search_path=pg_catalog,public as $$
begin
  if new.captured_proof_id is null then return new; end if;
  if new.captured_proof_id is distinct from old.captured_proof_id then
    update public.client_proof_assets p set
      capture_method='integration',
      source_category='customers',
      source_kind='Online Reviews',
      google_source_changed_at=case when new.gone_at is not null
        then clock_timestamp() else p.google_source_changed_at end
    where p.id=new.captured_proof_id and p.client_id=new.client_id;
  elsif new.gone_at is distinct from old.gone_at
     or new.comment is distinct from old.comment
     or new.review_url is distinct from old.review_url
     or new.reviewed_at is distinct from old.reviewed_at then
    update public.client_proof_assets p set
      google_source_changed_at=clock_timestamp()
    where p.id=new.captured_proof_id and p.client_id=new.client_id;
  end if;
  return new;
end $$;
create trigger google_review_proof_source_sync_v7
  after update of captured_proof_id,gone_at,comment,review_url,reviewed_at
  on public.google_reviews for each row
  execute function public.sync_google_review_proof_source_v7();

-- Old captured reviews get provenance. A review already gone when this
-- migration arrives is held immediately; no historical right is restored.
update public.client_proof_assets p set
  capture_method=coalesce(p.capture_method,'integration'),
  source_category=coalesce(p.source_category,'customers'),
  source_kind=coalesce(p.source_kind,'Online Reviews'),
  google_source_changed_at=case when r.gone_at is not null
    then clock_timestamp() else p.google_source_changed_at end
from public.google_reviews r
where r.captured_proof_id=p.id and r.client_id=p.client_id;

-- Rights may be reconsidered after a corrected source, but a review currently
-- removed from Google cannot receive a new approval.
create function public.guard_removed_google_review_rights_v7()
returns trigger language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
  if new.usage_rights='approved' and old.usage_rights is distinct from 'approved'
     and exists (select 1 from public.google_reviews r
       where r.captured_proof_id=new.id and r.client_id=new.client_id
         and (r.gone_at is not null or r.comment is distinct from new.body
           or r.review_url is distinct from new.source
           or r.reviewed_at::date is distinct from new.captured_on)) then
    raise exception 'A removed or changed Google review cannot be cleared for use.'
      using errcode='23514';
  end if;
  return new;
end $$;
create trigger google_review_rights_gate_v7
  before update of usage_rights on public.client_proof_assets
  for each row execute function public.guard_removed_google_review_rights_v7();

revoke all on function public.sync_google_review_proof_source_v7()
  from public,anon,authenticated,service_role;
revoke all on function public.guard_removed_google_review_rights_v7()
  from public,anon,authenticated,service_role;
commit;

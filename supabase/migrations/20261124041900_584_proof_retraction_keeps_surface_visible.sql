-- Rights withdrawal flags a placed item for retraction, but does not remove
-- it from the provider or page. Keep its destination in the coverage view
-- until a removal receipt moves the placement to retracted. A pre-placement
-- retraction request has no external exposure and remains outside the live
-- count.
create or replace view public.proof_surface_coverage with (security_invoker=true) as
with exposure as (
  select p.*,
    (p.status in ('placed','verified') or
      (p.status='retraction_required' and
        (p.placed_at is not null or p.external_id is not null
          or p.external_url is not null))) as removal_unconfirmed
  from public.proof_placements p
)
select
  pa.client_id,
  pa.id as proof_asset_id,
  pa.title,
  pa.proof_type,
  pa.usage_rights,
  pa.expires_on,
  count(p.id) filter (where p.removal_unconfirmed)::int as live_placements,
  count(p.id) filter (where p.status='bound')::int as bound_not_published,
  count(p.id) filter (where p.status='retraction_required')::int as needs_retracting,
  array_remove(array_agg(distinct p.destination_key)
    filter (where p.removal_unconfirmed),null) as live_on,
  case
    when pa.usage_rights<>'approved'
      and count(p.id) filter (where p.removal_unconfirmed)>0
      then 'This proof is still recorded on a surface and its rights are '
        ||pa.usage_rights||'. Confirm removal before clearing it.'
    when pa.expires_on is not null and pa.expires_on<current_date
      and count(p.id) filter (where p.removal_unconfirmed)>0
      then 'This proof is still recorded on a surface and permission expired on '
        ||pa.expires_on::text||'. Confirm removal before clearing it.'
    when count(p.id) filter (where p.status='retraction_required')>0
      then count(p.id) filter (where p.status='retraction_required')::text
        ||' placement(s) are waiting to be retracted.'
    when count(p.id) filter (where p.status='bound')>0
      and count(p.id) filter (where p.removal_unconfirmed)=0
      then 'Bound into a page that has not published, so it is not live anywhere yet.'
    else null
  end as problem
from public.client_proof_assets pa
left join exposure p on p.source_proof_id=pa.id
group by pa.client_id,pa.id,pa.title,pa.proof_type,pa.usage_rights,pa.expires_on;

comment on view public.proof_surface_coverage is
  'Proof destinations remain visible after rights withdrawal until a removal receipt is recorded. Pre-placement retraction requests are excluded from external exposure.';
grant select on public.proof_surface_coverage to authenticated;

-- Record the exact approved request when the sender claims a delivery. Earlier
-- attempts remain unattributed rather than inheriting a later review's outcome.
begin;

alter table public.proof_request_deliveries
 add column attempt_request_id uuid references public.approval_requests_v6(id);

create or replace function public.proof_delivery_send_ready_v6(p_delivery_id uuid)
returns boolean language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare d public.proof_request_deliveries%rowtype; q public.proof_delivery_reviews_v6%rowtype;
begin
 select * into d from public.proof_request_deliveries where id=p_delivery_id;
 select * into q from public.proof_delivery_reviews_v6 where delivery_id=p_delivery_id
  order by review_epoch desc limit 1;
 return coalesce(d.status in ('approved','sending') and d.approved_by is not null
  and q.canonical_request_id is not null
  and (d.status<>'sending' or d.attempt_request_id=q.canonical_request_id)
  and public.proof_delivery_source_state_v6(q.canonical_request_id)='source_decided'
  and exists(select 1 from public.approval_decision_events_v6 e
   where e.request_id=q.canonical_request_id and e.decision='approved'
    and e.actor_aal='aal2' and e.actor_id=d.approved_by and e.artifact_hash=q.source_hash)
  and exists(select 1 from public.proof_capture_links l where l.id=d.link_id
   and l.client_id=d.client_id and l.config_id=d.config_id and l.revoked_at is null
   and l.expires_at>now() and l.submissions<l.max_submissions),false);
end $$;

create or replace function public.claim_proof_delivery() returns public.proof_request_deliveries
language plpgsql security definer set search_path=pg_catalog,public as $$
declare d public.proof_request_deliveries; request_id uuid;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
 update public.proof_request_deliveries set status='uncertain',error='Delivery confirmation was interrupted; check provider history before sending again.'
  where status='sending' and lease_until<now();
 select * into d from public.proof_request_deliveries where status='approved'
  and scheduled_at<=now() order by scheduled_at for update skip locked limit 1;
 if d.id is null then return null; end if;
 if not public.proof_delivery_send_ready_v6(d.id) then
  update public.proof_request_deliveries set status='cancelled',
   error='Current exact Inbox approval or capture link is unavailable.' where id=d.id;
  return null;
 end if;
 select q.canonical_request_id into request_id from public.proof_delivery_reviews_v6 q
  where q.delivery_id=d.id order by q.review_epoch desc limit 1;
 if request_id is null then raise exception 'Exact proof delivery approval unavailable.' using errcode='23514'; end if;
 update public.proof_request_deliveries set status='sending',attempts=attempts+1,
  attempt_request_id=request_id,lease_until=now()+interval '2 minutes'
  where id=d.id returning * into d;
 return d;
end $$;

create or replace view public.proof_approval_execution_evidence_v6
with (security_barrier=true) as
select a.canonical_request_id as request_id,a.client_id,
  'proof_placement'::text as source_kind,p.status as state,
  case
    when p.status='retracted' and r.id is null
      then 'Historical removal has no confirmation receipt; external state is unknown.'
    when p.status='retracted' and r.legacy_audit
      then 'A person checked this historical removal later; provider readback is not proved.'
    when p.status='retracted'
      then 'Removal confirmation recorded; inspect the receipt in Proof Distribution.'
    when p.status='retraction_required'
      then 'Proof must be removed; a removal receipt has not been recorded.'
    when p.status in ('placed','verified')
      then 'Placement is recorded; inspect the owning source for provider verification.'
    when p.status='failed' then 'Placement failed; inspect the owning source for the error.'
    else 'No external placement is confirmed.'
  end as detail,
  coalesce(p.external_url,p.external_id) as external_ref
from public.proof_placement_approvals a
join public.proof_placements p on p.id=a.placement_id
  and p.approval_id=a.id and p.client_id=a.client_id
left join public.proof_placement_retraction_receipts_v6 r
  on r.placement_id=p.id and r.client_id=p.client_id
where a.canonical_request_id is not null
  and public.can_access_client(a.client_id)
union all
select q.canonical_request_id,q.client_id,'proof_delivery'::text,
  case when d.status in ('sending','sent','uncertain','failed')
    and d.attempt_request_id is distinct from q.canonical_request_id
    then 'unattributed' else d.status end,
  case
    when d.status in ('sending','sent','uncertain','failed')
      and d.attempt_request_id is distinct from q.canonical_request_id
      then 'A provider attempt exists, but it is not bound to this exact approval request. Inspect the owning source.'
    when d.status='sent'
      then 'A provider send is recorded under this exact approval request; recipient receipt is not proved.'
    when d.status='uncertain'
      then 'Provider effect under this exact request may have happened; inspect the owning source before retry.'
    when d.status='failed'
      then 'Send under this exact request failed; inspect the owning source for the error and retry policy.'
    when d.status='cancelled' then 'Send was cancelled.'
    else 'No provider send is confirmed.'
  end,
  case when d.attempt_request_id=q.canonical_request_id then d.provider_id else null end
from public.proof_delivery_reviews_v6 q
join public.proof_request_deliveries d on d.id=q.delivery_id
  and d.client_id=q.client_id
where q.canonical_request_id is not null
  and (public.is_admin()
    or auth.uid()=public.active_video_approval_manager(q.client_id));

comment on view public.proof_approval_execution_evidence_v6 is
 'Proof Inbox request to current source-row observation. Proof delivery attempts are attributed only when the sender recorded the exact approval request; provider acceptance does not prove recipient delivery or external removal.';

select public.lock_down_definer_functions();
commit;

-- Offer Strategy uses internally verified source records without a saved review gate.
-- Keep the snapshot shape so existing offer bindings remain comparable.
create or replace function public.reviewed_offer_strategy_snapshot_v7(p_client_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare result jsonb;
begin
  if auth.role() not in ('authenticated','service_role') or p_client_id is null
    or (auth.role()='authenticated' and not public.can_access_client(p_client_id)) then
    raise exception 'The client strategy is unavailable.' using errcode='42501'; end if;
  if exists(select 1 from public.record_templates t
    where t.domain='offer_strategy' and not exists(
      select 1 from public.model_section_review_state_v7 s
      where s.client_id=p_client_id and s.domain='offer_strategy'
        and s.item_key=t.item_key
        and nullif(btrim(coalesce(s.body,'')),'') is not null)) then
    raise exception 'Complete every required Offer Strategy section before building a main offer.'
      using errcode='23514'; end if;
  select jsonb_agg(jsonb_build_object(
    'record_id',s.record_id,'item_key',s.item_key,'title',s.title,'body',s.body,
    'record_hash',s.record_hash,'review_state',s.review_state,
    'model_job_id',s.model_job_id,
    'source_ref',s.source_ref,'observed_on',s.observed_on,
    'review_id',s.review_id,'reviewed_at',s.reviewed_at)
    order by s.item_key,s.record_id) into result
  from public.model_section_review_state_v7 s
  where s.client_id=p_client_id and s.domain='offer_strategy';
  if result is null or result='[]'::jsonb then
    raise exception 'Create Offer Strategy before building a main offer.'
      using errcode='23514'; end if;
  return result;
end $$;

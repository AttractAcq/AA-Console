-- A consented returning contact whose match is archived is retained as a
-- received submission. Public responses stay generic; human review is needed
-- before any new lead or archive recovery can be attributed to it.
begin;
alter table public.lead_submissions
  add column archive_match_lead_id uuid;
alter table public.lead_submissions
  add constraint lead_submissions_archive_match_identity_fkey_v11
  foreign key (archive_match_lead_id,client_id)
  references public.lead_identities(id,client_id) on delete restrict;
create index lead_submissions_archive_review_v11_idx
  on public.lead_submissions(client_id,created_at desc)
  where status='received' and archive_match_lead_id is not null;
comment on column public.lead_submissions.archive_match_lead_id is
  'Historical lead candidate for a consented returning submission. It is not a promoted lead or permission to reopen the archive.';
create or replace function public.capture_lead_v6(
  p_token_hash text,
  p_idempotency_key text,
  p_name text default null,
  p_email text default null,
  p_phone text default null,
  p_message text default null,
  p_consented boolean default false,
  p_evidence jsonb default '{}'::jsonb,
  p_click_id text default null,
  p_utm jsonb default null
) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  v_endpoint public.lead_capture_endpoints%rowtype;
  v_existing public.lead_submissions%rowtype;
  v_submission public.lead_submissions%rowtype;
  v_lead public.client_leads%rowtype;
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_dedupe text;
  v_created boolean := false;
  v_archived_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the internal service may capture a lead.';
  end if;

  select * into v_endpoint from public.lead_capture_endpoints
   where token_hash = p_token_hash;
  -- One sentence for every refusal, and the same sentence whether the token
  -- is wrong or the endpoint is off: a public caller learns nothing about
  -- which it was.
  if not found or not v_endpoint.enabled
     or v_endpoint.revoked_at is not null
     or v_endpoint.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'This form is not accepting submissions.');
  end if;
  if v_endpoint.submissions >= v_endpoint.max_submissions then
    return jsonb_build_object('ok', false, 'reason', 'This form has reached its limit.');
  end if;
  if not coalesce(p_consented, false) then
    return jsonb_build_object('ok', false, 'reason', 'Consent is required.');
  end if;
  if nullif(btrim(coalesce(p_email, '')), '') is null
     and nullif(btrim(coalesce(p_phone, '')), '') is null then
    return jsonb_build_object('ok', false, 'reason', 'An email address or a phone number is required.');
  end if;
  if v_key = '' then
    return jsonb_build_object('ok', false, 'reason', 'A submission reference is required.');
  end if;

  -- The same form posted twice is one submission. Taken on the client and
  -- key rather than globally, so two clients cannot collide.
  perform pg_advisory_xact_lock(hashtextextended(v_endpoint.client_id::text || ':lead:' || v_key, 0));
  select * into v_existing from public.lead_submissions
   where client_id = v_endpoint.client_id and idempotency_key = v_key;
  if found then
    return jsonb_build_object(
      'ok', true, 'submission_id', v_existing.id, 'lead_id', v_existing.lead_id,
      'created', false, 'repeat', true);
  end if;

  insert into public.lead_submissions (
    client_id, endpoint_id, name, email, phone, message,
    consent_wording, consent_given_at, consent_evidence,
    click_id, utm, idempotency_key)
  values (
    v_endpoint.client_id, v_endpoint.id,
    nullif(btrim(coalesce(p_name, '')), ''),
    nullif(btrim(coalesce(p_email, '')), ''),
    nullif(btrim(coalesce(p_phone, '')), ''),
    nullif(btrim(coalesce(p_message, '')), ''),
    -- Snapshotted, not referenced. The endpoint's wording may change; what
    -- this person agreed to may not.
    v_endpoint.consent_wording, now(),
    coalesce(p_evidence, '{}'::jsonb) || jsonb_build_object(
      'endpoint_id',v_endpoint.id,
      'source_snapshot',jsonb_build_object(
        'purpose',v_endpoint.purpose,
        'source_channel',v_endpoint.source_channel,
        'campaign_id',v_endpoint.campaign_id,
        'page_id',v_endpoint.page_id)),
    nullif(btrim(coalesce(p_click_id, '')), ''), p_utm, v_key)
  returning * into v_submission;

  update public.lead_capture_endpoints
     set submissions = submissions + 1 where id = v_endpoint.id;

  -- Deduplicate into an existing lead where one matches, and record the
  -- touch either way. A returning customer is one lead with a history, not a
  -- second row with half of it.
  v_dedupe := public.lead_dedupe_key(p_email, p_phone);
  -- Two different submission keys for the same contact must not race one
  -- another into duplicate active leads or conflicting archive decisions.
  perform pg_advisory_xact_lock(hashtextextended(
    v_endpoint.client_id::text || ':lead-contact:' || v_dedupe, 0));

  select * into v_lead from public.client_leads
   where client_id = v_endpoint.client_id and dedupe_key = v_dedupe
   order by created_at limit 1 for key share;

  if not found then
    -- The archived snapshot is historical evidence. A returning contact is
    -- received, but no second lead is created and no archived row is silently
    -- reopened. A human must decide the transition from this held submission.
    select a.id into v_archived_id from public.archived_leads a
     where a.client_id=v_endpoint.client_id
       and coalesce(a.lead->>'dedupe_key',
         public.lead_dedupe_key(a.lead->>'email',a.lead->>'phone'))=v_dedupe
     order by a.archived_at desc,a.id limit 1 for update;
    if v_archived_id is not null then
      update public.lead_submissions
        set archive_match_lead_id=v_archived_id
        where id=v_submission.id;
      return jsonb_build_object(
        'ok',true,'submission_id',v_submission.id,'lead_id',null,
        'created',false,'repeat',false,'pending_review',true);
    end if;
    insert into public.client_leads (
      client_id, name, email, phone, contact, notes, source, source_channel,
      consent_given_at, consent_wording, consent_evidence,
      source_client_campaign_id, source_page_id, source_click_id, source_utm)
    values (
      v_endpoint.client_id,
      nullif(btrim(coalesce(p_name, '')), ''),
      nullif(btrim(coalesce(p_email, '')), ''),
      nullif(btrim(coalesce(p_phone, '')), ''),
      coalesce(nullif(btrim(coalesce(p_email, '')), ''), nullif(btrim(coalesce(p_phone, '')), '')),
      nullif(btrim(coalesce(p_message, '')), ''),
      v_endpoint.purpose,
      coalesce(v_endpoint.source_channel, v_endpoint.purpose),
      v_submission.consent_given_at, v_submission.consent_wording, v_submission.consent_evidence,
      v_endpoint.campaign_id, v_endpoint.page_id,
      v_submission.click_id, v_submission.utm)
    returning * into v_lead;
    v_created := true;
  end if;

  update public.lead_submissions
     set status = 'promoted', lead_id = v_lead.id where id = v_submission.id;

  insert into public.lead_events (lead_id, client_id, kind, body)
  values (
    v_lead.id, v_endpoint.client_id, 'note',
    case when v_created then 'Captured from ' else 'Returned through ' end
      || replace(v_endpoint.purpose, '_', ' ')
      || '. Consent recorded.');

  return jsonb_build_object(
    'ok', true, 'submission_id', v_submission.id, 'lead_id', v_lead.id,
    'created', v_created, 'repeat', false);
end $$;

revoke all on function public.capture_lead_v6(
  text,text,text,text,text,text,boolean,jsonb,text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.capture_lead_v6(
  text,text,text,text,text,text,boolean,jsonb,text,jsonb) to service_role;
select public.lock_down_definer_functions();
commit;

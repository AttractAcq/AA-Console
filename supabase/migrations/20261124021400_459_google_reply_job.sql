-- An AAL2 account owner may request a controlled send of one exact approved
-- Google reply. Runtime release remains off by default.
begin;

insert into public.agents
  (agent_key,name,initials,domain,description,requires_upstream,config,paused)
values ('google_reply_sender','Google Reply Sender','GR','google',
  'Sends one exact approved Business Profile review reply and records readback.',
  '{}','{}',false)
on conflict (agent_key) do nothing;

create unique index google_reply_one_send_job_v6
  on public.agent_jobs(input_id)
  where agent_key='google_reply_sender'
    and input_table='google_review_replies' and input_id is not null;

create function public.request_google_reply_send_v6(p_reply_id uuid)
returns uuid language plpgsql volatile security definer
set search_path=pg_catalog,public set timezone='UTC' as $$
declare
  g public.google_review_replies%rowtype;
  c public.google_reply_context_bindings_v6%rowtype;
  v_review public.google_reviews%rowtype;
  l public.client_google_locations%rowtype;
  p jsonb;
  v_job uuid;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null
    or coalesce(auth.jwt()->>'aal','') <> 'aal2' then
    raise exception 'A provisioned AAL2 owner must request this Google reply send.'
      using errcode='42501';
  end if;
  select * into g from public.google_review_replies where id=p_reply_id for update;
  if g.id is null or not (coalesce(public.is_admin(),false)
    or auth.uid()=public.active_video_approval_manager(g.client_id)) then
    raise exception 'Only the client approval owner may request this reply send.'
      using errcode='42501';
  end if;
  if g.status<>'approved' then
    raise exception 'The Google reply needs its exact human approval before send.'
      using errcode='23514'; end if;
  select * into c from public.google_reply_context_bindings_v6 where reply_id=g.id;
  select * into v_review from public.google_reviews where id=g.review_id
    and client_id=g.client_id;
  select * into l from public.client_google_locations where id=v_review.location_id
    and client_id=g.client_id;
  p:=public.google_reply_inbox_payload_v6(g);
  if c.reply_id is null or v_review.id is null or l.id is null
    or v_review.gone_at is not null or l.verification_state<>'verified'
    or c.review_epoch is distinct from v_review.approval_epoch_v6
    or c.location_epoch is distinct from l.approval_epoch_v6
    or p->>'preview_blocker' is not null
    or not exists(select 1 from public.approval_inbox_v6 i
      where i.id=c.approval_request_id and i.status='approved'
        and i.source_kind='google_review_reply'
        and i.source_id=g.id::text
        and i.source_version=p->>'source_version'
        and i.artifact_hash=p->>'artifact_hash') then
    raise exception 'The Google reply approval or destination changed; review a new exact version.'
      using errcode='23514';
  end if;
  select id into v_job from public.agent_jobs
    where agent_key='google_reply_sender'
      and input_table='google_review_replies' and input_id=g.id;
  if v_job is not null then return v_job; end if;
  insert into public.agent_jobs
    (agent_key,client_id,input_table,input_id,params,created_by)
  values ('google_reply_sender',g.client_id,'google_review_replies',g.id,
    jsonb_build_object('reply_id',g.id,'approval_request_id',c.approval_request_id),auth.uid())
  returning id into v_job;
  return v_job;
end $$;

revoke all on function public.request_google_reply_send_v6(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.request_google_reply_send_v6(uuid)
  to authenticated;

select public.lock_down_definer_functions();
commit;

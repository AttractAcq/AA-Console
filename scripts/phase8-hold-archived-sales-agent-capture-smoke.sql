-- A captured sales-agent conversation keeps its historical identity after
-- archive. A separate returning conversation is retained for review.
begin;
insert into public.clients(id,name,initials) values
  ('b6430000-0000-4000-8000-000000000001','Sales return fixture','SR'),
  ('b6430000-0000-4000-8000-000000000002','Other sales fixture','OS');
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
do $fixture$
declare cid uuid:='b6430000-0000-4000-8000-000000000001';
  other_id uuid:='b6430000-0000-4000-8000-000000000002';
  agent_id uuid; first_conv uuid; return_conv uuid; active_conv uuid;
  first_lead uuid; same_lead uuid; withheld uuid; refused boolean:=false;
  held_snapshot jsonb;
begin
  insert into public.client_sales_agents(client_id,name,purpose)
    values(cid,'Sales return agent','Fixture') returning id into agent_id;
  insert into public.sales_agent_conversations(
    client_id,sales_agent_id,contact_name,contact_email,transcript)
  values(cid,agent_id,'Returning contact','return-sales@example.invalid','[]'::jsonb)
    returning id into first_conv;
  first_lead:=public.capture_sales_agent_lead(first_conv);
  if first_lead is null or public.capture_sales_agent_lead(first_conv)
      is distinct from first_lead then
    raise exception 'First sales capture was not idempotent';
  end if;
  insert into public.sales_agent_conversations(
    client_id,sales_agent_id,contact_name,contact_email,transcript)
  values(cid,agent_id,'Returning contact','return-sales@example.invalid','[]'::jsonb)
    returning id into active_conv;
  same_lead:=public.capture_sales_agent_lead(active_conv);
  if same_lead is distinct from first_lead
    or (select count(*) from public.client_leads where client_id=cid)<>1 then
    raise exception 'Active matching contact became a duplicate lead';
  end if;
  perform public.archive_lead(first_lead,'Finished sales fixture');
  if (select lead_id from public.sales_agent_conversations where id=first_conv)
      is distinct from first_lead
    or public.capture_sales_agent_lead(first_conv) is distinct from first_lead
    or exists(select 1 from public.client_leads where client_id=cid) then
    raise exception 'Archived sales conversation lost its lead identity';
  end if;
  insert into public.sales_agent_conversations(
    client_id,sales_agent_id,contact_name,contact_email,transcript)
  values(cid,agent_id,'Returning contact','return-sales@example.invalid','[]'::jsonb)
    returning id into return_conv;
  withheld:=public.capture_sales_agent_lead(return_conv);
  if withheld is not null or public.capture_sales_agent_lead(return_conv) is not null
    or not exists(select 1 from public.sales_agent_conversations
      where id=return_conv and lead_id is null
        and archive_match_lead_id=first_lead
        and archive_match_snapshot->>'contact_key'=
          public.lead_dedupe_key('return-sales@example.invalid',null)
        and archive_match_snapshot->>'transcript_sha256' is not null)
    or exists(select 1 from public.client_leads where client_id=cid) then
    raise exception 'Archived contact was silently recreated';
  end if;
  select archive_match_snapshot into held_snapshot
    from public.sales_agent_conversations where id=return_conv;
  update public.sales_agent_conversations
    set contact_name='New agent observation',outcome='Later turn',
        transcript='[{"role":"user","content":"Later turn"}]'::jsonb
    where id=return_conv;
  if (select archive_match_snapshot from public.sales_agent_conversations
      where id=return_conv) is distinct from held_snapshot
    or held_snapshot->>'contact_name' is distinct from 'Returning contact' then
    raise exception 'Match-time contact source changed after another turn';
  end if;
  begin
    update public.sales_agent_conversations set lead_id=first_lead
      where id=return_conv;
  exception when check_violation then refused:=true; end;
  if not refused then raise exception 'Held conversation was promoted directly'; end if;
  refused:=false;
  begin
    update public.sales_agent_conversations
      set archive_match_lead_id=first_lead,client_id=other_id
      where id=return_conv;
  exception when check_violation or foreign_key_violation then refused:=true; end;
  if not refused then raise exception 'Cross-client archived candidate was accepted'; end if;
  refused:=false;
  begin
    insert into public.sales_agent_conversations(
      client_id,sales_agent_id,lead_id,transcript)
    values(cid,agent_id,first_lead,'[]'::jsonb);
  exception when foreign_key_violation then refused:=true; end;
  if not refused then raise exception 'Archived lead attached to new operational conversation'; end if;
end $fixture$;
rollback;

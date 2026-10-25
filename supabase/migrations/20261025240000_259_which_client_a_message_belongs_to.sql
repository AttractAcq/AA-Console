-- G01, the doorway: which client an inbound message belongs to.
--
-- Meta addresses a webhook to the page or Instagram account that received
-- it, not to us. `client_integrations.meta_page_id` is the only mapping
-- from that id back to a client, so this is the lookup the webhook makes --
-- and it is a function rather than a query in the route for one reason: a
-- webhook is an unauthenticated doorway, and the smaller the surface it can
-- reach, the better.
--
-- A message for a page we do not recognise is not an error. Meta sends
-- events for every page an app is installed on, including ones a client has
-- since disconnected, and a 500 would make Meta retry it forever.

create or replace function public.client_for_meta_recipient_v6(p_recipient_id text)
returns uuid language sql stable security definer
set search_path = pg_catalog, public as $fn$
  select i.client_id from public.client_integrations i
   where i.provider = 'meta'
     and i.meta_page_id = nullif(btrim(coalesce(p_recipient_id, '')), '')
     and i.status = 'connected'
   order by i.updated_at desc nulls last
   limit 1;
$fn$;

comment on function public.client_for_meta_recipient_v6(text) is
  'The client whose connected Meta integration owns this page or account id, or null. Null is an expected answer: Meta sends events for pages a client has since disconnected.';

revoke all on function public.client_for_meta_recipient_v6(text) from public, anon, authenticated;
grant execute on function public.client_for_meta_recipient_v6(text) to service_role;

-- Closing a thread by hand, for when a person has dealt with it elsewhere.
create or replace function public.close_dm_conversation_v6(
  p_conversation_id uuid, p_reason text)
returns public.dm_conversations language plpgsql security definer
set search_path = pg_catalog, public as $fn$
declare c public.dm_conversations%rowtype;
begin
  select * into c from public.dm_conversations where id = p_conversation_id for update;
  if not found then raise exception 'No such conversation.' using errcode = 'P0001'; end if;
  if not (coalesce(public.is_admin(), false)
          or coalesce(public.can_access_client(c.client_id), false)) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Say why it was closed.' using errcode = 'P0001';
  end if;
  update public.dm_conversations
     set status = 'closed', closed_reason = btrim(p_reason), unread_inbound = 0
   where id = p_conversation_id returning * into c;
  return c;
end $fn$;

revoke all on function public.close_dm_conversation_v6(uuid, text) from public, anon;
grant execute on function public.close_dm_conversation_v6(uuid, text) to authenticated;

-- Attaching a thread to a lead somebody already knew about. A DM creates its
-- own lead because it has to create something, and the same person may
-- already be in the pipeline from a form.
create or replace function public.merge_dm_lead_v6(
  p_conversation_id uuid, p_lead_id uuid)
returns public.dm_conversations language plpgsql security definer
set search_path = pg_catalog, public as $fn$
declare
  c public.dm_conversations%rowtype;
  l public.client_leads%rowtype;
  v_old uuid;
begin
  select * into c from public.dm_conversations where id = p_conversation_id for update;
  if not found then raise exception 'No such conversation.' using errcode = 'P0001'; end if;
  if not (coalesce(public.is_admin(), false)
          or coalesce(public.can_access_client(c.client_id), false)) then
    raise exception 'Not permitted for this client.' using errcode = 'P0001';
  end if;
  select * into l from public.client_leads where id = p_lead_id;
  if not found then raise exception 'No such lead.' using errcode = 'P0001'; end if;
  if l.client_id <> c.client_id then
    raise exception 'That lead belongs to a different client.' using errcode = 'P0001';
  end if;
  if l.is_probe then
    raise exception 'That is a probe lead.' using errcode = 'P0001';
  end if;

  v_old := c.lead_id;
  update public.dm_conversations set lead_id = p_lead_id where id = p_conversation_id
    returning * into c;
  update public.dm_identities set lead_id = p_lead_id where id = c.identity_id;

  -- The lead the thread invented is archived rather than deleted: its events
  -- are the history of this conversation and deleting them would lose it.
  if v_old is not null and v_old <> p_lead_id then
    insert into public.lead_events (lead_id, client_id, kind, detail)
    values (p_lead_id, c.client_id, 'note',
            'A ' || c.platform || ' conversation was merged into this lead from ' || v_old::text || '.');
  end if;
  return c;
end $fn$;

comment on function public.merge_dm_lead_v6(uuid, uuid) is
  'Points a thread at a lead somebody already knew about. The lead the thread invented keeps its events, because they are the history of the conversation.';

revoke all on function public.merge_dm_lead_v6(uuid, uuid) from public, anon;
grant execute on function public.merge_dm_lead_v6(uuid, uuid) to authenticated;

select lock_down_definer_functions();

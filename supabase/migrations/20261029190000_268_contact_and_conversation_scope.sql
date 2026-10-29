-- B005: a creative job/client assignment is not permission to read a lead's
-- contact, consent, appointment, send, or conversation history. Keep existing
-- admin, same-client user and service routes, and admit only an explicitly
-- entitled sales employee once migration 267's Inbox gate is actually live.

create or replace function public.can_read_client_sales_data(target uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  -- Reuse the lead permission contract. Its direct EXECUTE remains closed to
  -- authenticated users; this wrapper is limited to row-policy use.
  select public.may_manage_client_leads(target);
$$;
revoke execute on function public.can_read_client_sales_data(uuid)
  from public, anon;
grant execute on function public.can_read_client_sales_data(uuid)
  to authenticated, service_role;

drop policy if exists lead_submissions_read on public.lead_submissions;
create policy lead_submissions_read on public.lead_submissions
  for select to authenticated
  using (public.can_read_client_sales_data(client_id));

drop policy if exists lead_magnet_deliveries_read on public.lead_magnet_deliveries;
create policy lead_magnet_deliveries_read on public.lead_magnet_deliveries
  for select to authenticated
  using (public.can_read_client_sales_data(client_id));

drop policy if exists lead_sequence_enrollments_read on public.lead_sequence_enrollments;
create policy lead_sequence_enrollments_read on public.lead_sequence_enrollments
  for select to authenticated
  using (public.can_read_client_sales_data(client_id));

drop policy if exists lead_suppressions_read on public.lead_suppressions;
create policy lead_suppressions_read on public.lead_suppressions
  for select to authenticated
  using (public.can_read_client_sales_data(client_id));

drop policy if exists outbound_messages_read on public.outbound_messages;
create policy outbound_messages_read on public.outbound_messages
  for select to authenticated
  using (public.can_read_client_sales_data(client_id));

drop policy if exists client_appointments_read on public.client_appointments;
create policy client_appointments_read on public.client_appointments
  for select to authenticated
  using (public.can_read_client_sales_data(client_id));

drop policy if exists dm_identities_read on public.dm_identities;
create policy dm_identities_read on public.dm_identities
  for select to authenticated
  using (public.can_read_client_sales_data(client_id));

drop policy if exists dm_conversations_read on public.dm_conversations;
create policy dm_conversations_read on public.dm_conversations
  for select to authenticated
  using (public.can_read_client_sales_data(client_id));

drop policy if exists dm_messages_read on public.dm_messages;
create policy dm_messages_read on public.dm_messages
  for select to authenticated
  using (public.can_read_client_sales_data(client_id));

-- The original sales-agent transcript policy was client-only. Preserve it;
-- add a second read path for a live explicit sales employee without exposing
-- the agent's configuration or its deployment controls.
create policy sac_sales_read on public.sales_agent_conversations
  for select to authenticated
  using (public.has_client_sales_entitlement(client_id));
grant select on public.sales_agent_conversations to authenticated;

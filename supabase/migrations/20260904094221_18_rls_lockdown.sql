-- ============================================================
-- AA Console · 18 · RLS lockdown
--
-- Removes the 33 dev_open_read policies from migration 12 and lets the
-- per-role policies underneath become authoritative. The resulting matrix:
--
--   admin     every table
--   employee  own profile, own team_members row, own job/client
--             assignments, own work logs, own pay, own uploads, the
--             clients they are assigned to (and those clients' briefs),
--             SOPs, and the chat channels they belong to
--   client    their own client row, business context, media, proof,
--             schedule, onboarding, contracts, billing, and the chat
--             channels they belong to
--
-- Deliberately admin-only: finance_periods, finance_entries,
-- client_audit_notes, client_integrations, ref_counters.
-- Clients keep read on their own contracts and billing; the audit notes
-- are internal account-review commentary and stay hidden from them.
-- ============================================================

-- ---------- gap: chat needs to resolve other people's names ----------
-- profiles was self-read only, so every message from someone else would
-- have rendered as "Unknown" the moment the open policy went away.
create policy profiles_channel_peer_read on profiles
  for select to authenticated
  using (
    exists (
      select 1
        from channel_members mine
        join channel_members theirs on theirs.channel_id = mine.channel_id
       where mine.user_id = auth.uid()
         and theirs.user_id = profiles.id
    )
  );

-- ---------- drop the dev-stage blanket read ----------
do $$
declare
  r record;
  dropped int := 0;
begin
  for r in
    select tablename from pg_policies
     where schemaname = 'public' and policyname = 'dev_open_read'
  loop
    execute format('drop policy dev_open_read on public.%I', r.tablename);
    dropped := dropped + 1;
  end loop;
  raise notice 'dropped dev_open_read from % tables', dropped;
end;
$$;

comment on schema public is
  'AA Console. Per-role RLS is authoritative as of migration 18; the dev-stage
   dev_open_read policies have been removed.';;

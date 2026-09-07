-- Repurposing Engine: one finished asset becomes many pieces.
--
-- The obvious build is a "Generate Reel" button. AA cannot cut video, so that
-- button would produce either nothing or a lie. What AA can do — and what the
-- rest of this system is already shaped around — is write a brief.
--
-- So a repurpose produces a derivative BRIEF, carrying the full Brief Studio
-- structure, linked back to the asset it came from. A reel derived from a
-- static ad is a reel brief; it then flows through Approve & Build or a
-- dispatch to an editor exactly like any other brief. No new production
-- machinery, nothing pretending to be finished work, and the root asset is
-- recorded so performance can later be traced to the piece it came from as
-- well as the idea underneath it.
--
-- This is also why Brief Studio came first: a derivative is written from the
-- root's hook and call to action, and those only became readable as fields
-- when briefs stopped being prose.

alter table client_briefs
  add column derived_from_asset_id uuid references client_media_assets(id) on delete set null,
  add column repurpose_format      text;

comment on column client_briefs.derived_from_asset_id is
  'The finished asset this brief was repurposed from. Null for an original brief written from an idea.';
comment on column client_briefs.repurpose_format is
  'What kind of derivative: reel, short, carousel, quote_graphic, text_post, email, ad_variation, story_clips. Null on an original.';

create index client_briefs_derived_idx
  on client_briefs (derived_from_asset_id)
  where derived_from_asset_id is not null;

-- Queue a repurpose. Mirrors enqueue_agent_job's guards rather than trusting
-- the caller: the asset must belong to a client this person can reach, and it
-- must be approved — repurposing something that failed review would multiply
-- a rejected piece.
create or replace function repurpose_asset(p_asset_id uuid, p_formats text[])
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_client_id uuid;
  v_status    review_status;
  v_job_id    uuid;
begin
  select client_id, review_status into v_client_id, v_status
    from client_media_assets where id = p_asset_id;

  if v_client_id is null then
    raise exception 'That asset no longer exists.';
  end if;
  if not can_access_client(v_client_id) then
    raise exception 'Not permitted for this client';
  end if;
  if v_status <> 'approved' then
    raise exception 'Only an approved asset can be repurposed - this one is %.', v_status;
  end if;
  if p_formats is null or array_length(p_formats, 1) is null then
    raise exception 'Choose at least one format to repurpose into.';
  end if;
  if array_length(p_formats, 1) > 6 then
    raise exception 'Six formats at a time is the limit; each one is a brief that costs model usage.';
  end if;

  insert into agent_jobs (agent_key, client_id, input_table, input_id, params, created_by)
  values ('repurpose', v_client_id, 'client_media_assets', p_asset_id,
          jsonb_build_object('formats', to_jsonb(p_formats)), auth.uid())
  returning id into v_job_id;

  return v_job_id;
end;
$$;

revoke execute on function repurpose_asset(uuid, text[]) from public, anon;
grant  execute on function repurpose_asset(uuid, text[]) to authenticated, service_role;

comment on function repurpose_asset(uuid, text[]) is
  'Queues the repurpose agent for one approved asset. Each requested format becomes a derivative brief.';

insert into agents (agent_key, name, initials, domain, description, requires_upstream, requires_input)
values ('repurpose', 'Repurposing Engine', 'RP', 'content',
        'Turns one finished asset into briefs for the other formats it should exist in.',
        '{}', true)
on conflict (agent_key) do nothing;

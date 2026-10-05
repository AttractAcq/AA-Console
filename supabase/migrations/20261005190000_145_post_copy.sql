-- The words that go out with the post.
--
-- Until now the only place to put a caption was scheduled_posts.notes, which
-- is one free-text field shared by every platform and read by nobody. A reel
-- that goes to Instagram and LinkedIn needs two captions, two hashtag sets and
-- two opinions about whether a link belongs in the body or the first comment.
-- The publisher (M2) has to be handed the exact text per platform, and the
-- copywriter agent (M3.8) has to have somewhere to write it.
--
-- Copy hangs off either a scheduled post or an asset, and exactly one of them.
-- Asset-level copy is the default a post inherits before it is scheduled, which
-- is what the copywriter produces; post-level copy is what a person edited for
-- that particular slot. Allowing both on one row would make "which caption goes
-- out" a question with two answers.
--
-- Per-platform length limits are deliberately NOT duplicated here. They live in
-- one shared module (agent-runtime/src/content/platform-limits.ts, mirrored in
-- src/lib/platformLimits.ts) because they change when the platforms change them
-- and a migration is the wrong place to find that out. The database enforces
-- only what is structural: a known platform, a known source, and a hard ceiling
-- that no platform comes close to, so a bug cannot park a megabyte in a caption.

create table if not exists post_copy (
  id uuid primary key default gen_random_uuid(),

  -- Exactly one parent. See the check below.
  scheduled_post_id uuid references scheduled_posts(id) on delete cascade,
  asset_id uuid references client_media_assets(id) on delete cascade,

  -- Denormalised from the parent by trigger, so RLS can be a column test
  -- rather than a join on every row read.
  client_id uuid references clients(id) on delete cascade,

  platform post_platform not null,

  caption text,
  hashtags text[] not null default '{}',
  alt_text text,
  link_url text,
  first_comment text,
  cta text,

  -- Who wrote it. An agent draft a person then edits becomes 'human'.
  source text not null default 'human',
  -- Bumped by trigger on every edit. The row is current; the number says how
  -- many times it has been rewritten.
  version integer not null default 1,

  created_by uuid references auth.users(id) on delete set null,
  created_by_bot text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint post_copy_one_parent check (
    (scheduled_post_id is not null and asset_id is null)
    or (scheduled_post_id is null and asset_id is not null)
  ),
  constraint post_copy_source check (source in ('human', 'agent')),
  -- Nothing structural, just a ceiling. The real limits are per platform and
  -- live in the shared module.
  constraint post_copy_caption_ceiling check (caption is null or length(caption) <= 10000),
  constraint post_copy_first_comment_ceiling check (first_comment is null or length(first_comment) <= 10000),
  constraint post_copy_hashtag_count check (array_length(hashtags, 1) is null or array_length(hashtags, 1) <= 100)
);

comment on table post_copy is
  'Caption, hashtags and the rest, per platform, for a scheduled post or for an asset. Exactly one parent. Per-platform length limits live in the shared platform-limits module, not here.';
comment on column post_copy.version is
  'How many times this copy has been rewritten. The row itself is always the current one.';
comment on column post_copy.source is
  'human or agent. An agent draft that a person edits becomes human.';

-- One current copy per platform per parent. Two partial uniques rather than one
-- over a coalesce, so each reads as the rule it is.
create unique index if not exists post_copy_one_per_post_platform
  on post_copy (scheduled_post_id, platform) where scheduled_post_id is not null;
create unique index if not exists post_copy_one_per_asset_platform
  on post_copy (asset_id, platform) where asset_id is not null;

create index if not exists post_copy_client_idx on post_copy (client_id);

-- ---------------------------------------------------------------------------
-- Keeping client_id true
-- ---------------------------------------------------------------------------

create or replace function public.sync_post_copy_parent()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.scheduled_post_id is not null then
    select sp.client_id into new.client_id from scheduled_posts sp where sp.id = new.scheduled_post_id;
  else
    select a.client_id into new.client_id from client_media_assets a where a.id = new.asset_id;
  end if;
  if new.client_id is null then
    raise exception 'That copy has no client: its post or asset does not exist.';
  end if;

  if tg_op = 'UPDATE' then
    new.created_at := old.created_at;
    new.updated_at := now();
    -- Only a change to the words is a new version. Touching the row to fix
    -- its client or its source is not a rewrite.
    if (new.caption, new.hashtags, new.alt_text, new.link_url, new.first_comment, new.cta)
       is distinct from
       (old.caption, old.hashtags, old.alt_text, old.link_url, old.first_comment, old.cta) then
      new.version := old.version + 1;
    else
      new.version := old.version;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists post_copy_sync_parent on post_copy;
create trigger post_copy_sync_parent
before insert or update on post_copy
for each row execute function public.sync_post_copy_parent();

-- ---------------------------------------------------------------------------
-- RLS, matching scheduled_posts
-- ---------------------------------------------------------------------------

alter table post_copy enable row level security;

-- Same shape as sp_admin_all / sp_scoped_read: an admin writes, everyone with
-- access to the client reads, and ordinary writes go through the RPC below.
drop policy if exists post_copy_admin_all on post_copy;
create policy post_copy_admin_all on post_copy
  for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists post_copy_scoped_read on post_copy;
create policy post_copy_scoped_read on post_copy
  for select to authenticated
  using (client_id is null or can_access_client(client_id));

-- ---------------------------------------------------------------------------
-- Writing it
-- ---------------------------------------------------------------------------

-- The editor's one way in. Guarded by can_access_client, like schedule_asset,
-- so a person who may schedule for a client may also write its copy without
-- being an admin. Upsert rather than insert-or-update at the call site: the
-- unique indexes above make "the copy for this platform" a single row, and the
-- caller should not have to know whether it exists yet.
create or replace function public.set_post_copy(
  p_platform post_platform,
  p_scheduled_post_id uuid default null,
  p_asset_id uuid default null,
  p_caption text default null,
  p_hashtags text[] default '{}',
  p_alt_text text default null,
  p_link_url text default null,
  p_first_comment text default null,
  p_cta text default null,
  p_source text default 'human'
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_client uuid;
  v_id uuid;
begin
  if (p_scheduled_post_id is null) = (p_asset_id is null) then
    raise exception 'Copy belongs to a scheduled post or to an asset, not both and not neither.';
  end if;

  if p_scheduled_post_id is not null then
    select sp.client_id into v_client from scheduled_posts sp where sp.id = p_scheduled_post_id;
    if v_client is null then
      raise exception 'That scheduled post does not exist.';
    end if;
  else
    select a.client_id into v_client from client_media_assets a where a.id = p_asset_id;
    if v_client is null then
      raise exception 'That asset does not exist.';
    end if;
  end if;

  if not can_access_client(v_client) then
    raise exception 'Not permitted for this client';
  end if;

  -- Two statements, not one with a fallback: the conflict target has to name
  -- the partial index that applies, and only one of them ever does.
  if p_scheduled_post_id is not null then
    insert into post_copy as pc (
      scheduled_post_id, platform, caption, hashtags,
      alt_text, link_url, first_comment, cta, source, created_by
    ) values (
      p_scheduled_post_id, p_platform, p_caption, coalesce(p_hashtags, '{}'),
      p_alt_text, p_link_url, p_first_comment, p_cta, p_source, auth.uid()
    )
    on conflict (scheduled_post_id, platform) where scheduled_post_id is not null
    do update set
      caption = excluded.caption,
      hashtags = excluded.hashtags,
      alt_text = excluded.alt_text,
      link_url = excluded.link_url,
      first_comment = excluded.first_comment,
      cta = excluded.cta,
      source = excluded.source
    returning pc.id into v_id;
  else
    insert into post_copy as pc (
      asset_id, platform, caption, hashtags,
      alt_text, link_url, first_comment, cta, source, created_by
    ) values (
      p_asset_id, p_platform, p_caption, coalesce(p_hashtags, '{}'),
      p_alt_text, p_link_url, p_first_comment, p_cta, p_source, auth.uid()
    )
    on conflict (asset_id, platform) where asset_id is not null
    do update set
      caption = excluded.caption,
      hashtags = excluded.hashtags,
      alt_text = excluded.alt_text,
      link_url = excluded.link_url,
      first_comment = excluded.first_comment,
      cta = excluded.cta,
      source = excluded.source
    returning pc.id into v_id;
  end if;

  return v_id;
end;
$$;

comment on function public.set_post_copy is
  'Write the copy for one platform, on a scheduled post or an asset. Upserts: there is one current copy per platform per parent.';

revoke all on function public.set_post_copy(
  post_platform, uuid, uuid, text, text[], text, text, text, text, text) from public;
grant execute on function public.set_post_copy(
  post_platform, uuid, uuid, text, text[], text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Reading it the way the publisher will
-- ---------------------------------------------------------------------------

-- Post-level copy wins over asset-level. Asset copy is the draft a post
-- inherits; once someone has written copy for the slot, that is the copy.
-- Post-level copy wins over asset-level. Asset copy is the draft a post
-- inherits; once someone has written copy for the slot, that is the copy.
-- distinct on picks one row per post and platform, and the order puts
-- post-level first because (scheduled_post_id is null) sorts false before true.
create or replace view post_copy_effective as
select distinct on (sp.id, c.platform)
  sp.id as scheduled_post_id,
  sp.client_id,
  sp.asset_id,
  c.platform,
  c.caption,
  c.hashtags,
  c.alt_text,
  c.link_url,
  c.first_comment,
  c.cta,
  case when c.scheduled_post_id is not null then 'post' else 'asset' end as level,
  c.source
from scheduled_posts sp
join post_copy c
  on c.scheduled_post_id = sp.id
  or (sp.asset_id is not null and c.asset_id = sp.asset_id)
order by sp.id, c.platform, (c.scheduled_post_id is null);

comment on view post_copy_effective is
  'The copy that would actually go out for each scheduled post and platform. Post-level copy overrides the asset-level draft it inherits.';

import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 160 against a real Postgres.
 *
 * The only thing in this system that makes a client's account say something
 * in public, so these tests are almost entirely about what it refuses. The
 * gate is a column in a view — `blocker` — and each case below pins one
 * sentence it must say, because a blocker the queue cannot name is a post
 * that silently never goes out.
 *
 * Two of them matter more than the rest. A stale claim must fail rather than
 * retry, because a crash after the platform call looks exactly like one
 * before it. And publishing must be off until somebody turns it on for that
 * client, not for the fleet.
 */
let db: PGlite;

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PILLAR = "33333333-3333-4333-8333-333333333333";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET = "55555555-5555-4555-8555-555555555555";

async function one<T = Record<string, unknown>>(sql: string): Promise<T> {
  return (await db.query<T>(sql)).rows[0]!;
}
async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return (await db.query<T>(sql)).rows;
}

async function asEngine<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  await db.exec(`select set_config('request.jwt.claim.role','service_role',false);
                 select set_config('request.jwt.claim.sub','',false);`);
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
                   select set_config('request.jwt.claim.sub','${ADMIN}',false);`);
  }
}

/**
 * A post as the approval step leaves it: an approved asset, a caption, a
 * usable integration, a time that has come, and publishing on.
 */
async function publishablePost(
  over: {
    platform?: string;
    approved?: boolean;
    caption?: string | null;
    due?: string;
    integration?: string | null;
    publishing?: boolean;
    renderPath?: string | null;
  } = {},
): Promise<{ post: string; asset: string }> {
  const platform = over.platform ?? "instagram";
  const { id: asset } = await one<{ id: string }>(
    `insert into client_media_assets (client_id, title, storage_path, render_path, human_approved_at, review_status)
     values ('${CLIENT}','Built','assets/raw.mp4',
             ${over.renderPath === undefined ? `'assets/cut.mp4'` : over.renderPath === null ? "null" : `'${over.renderPath}'`},
             ${over.approved === false ? "null" : "now()"},
             ${over.approved === false ? "'pending'" : "'approved'"}) returning id`,
  );
  const { id: post } = await one<{ id: string }>(
    `insert into scheduled_posts (client_id, asset_id, scheduled_for, scheduled_at, platform, media_type)
     values ('${CLIENT}','${asset}', current_date, ${over.due ?? "now() - interval '1 hour'"},
             '${platform}'::post_platform, 'video') returning id`,
  );
  if (over.caption !== null) {
    await db.exec(`insert into post_copy (scheduled_post_id, platform, caption, hashtags, alt_text, source)
                   values ('${post}','${platform}',
                           '${over.caption ?? "Five steps, one chain."}',
                           array['#proof'],'Cards in a row.','agent')`);
  }
  const provider = over.integration === undefined ? "instagram" : over.integration;
  if (provider !== null) {
    await db.exec(`insert into client_integrations (client_id, provider, credential_secret_id, status)
                   values ('${CLIENT}','${provider}','${SECRET}','connected')
                   on conflict do nothing`);
  }
  if (over.publishing !== false) {
    await db.exec(`select set_publishing_enabled('${CLIENT}', true)`);
  }
  return { post, asset };
}

const blockerOf = async (post: string) =>
  (await one<{ blocker: string | null }>(`select blocker from publish_due where post_id = '${post}'`)).blocker;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema cron; create schema vault;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role', true) $$;
    create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
    create function cron.schedule(a text,b text,c text) returns bigint language sql as
      $$ insert into cron.job (jobname,schedule,command) values (a,b,c) returning jobid $$;
    create function cron.unschedule(a text) returns boolean language sql as
      $$ delete from cron.job where jobname=a returning true $$;
    create table vault.decrypted_secrets (id uuid primary key, decrypted_secret text);
    insert into vault.decrypted_secrets (id, decrypted_secret) values ('${SECRET}','a-token');

    create type post_platform as enum ('facebook','instagram','tiktok','linkedin','youtube');
    create type post_channel as enum ('organic','paid');
    create type content_format as enum ('single','carousel','story','reel');
    create type media_type as enum ('image','text','video');
    create type review_status as enum ('pending','approved','rejected');

    create table clients (id uuid primary key, name text, timezone text not null default 'Europe/London');
    create table profiles (id uuid primary key, role text);
    create table client_members (client_id uuid, user_id uuid);
    create function is_admin() returns boolean language sql stable security definer as
      $$ select exists (select 1 from profiles where id = auth.uid() and role='admin') $$;
    create function can_access_client(p uuid) returns boolean language sql stable security definer as
      $$ select is_admin() or exists (select 1 from client_members m
            where m.client_id=p and m.user_id=auth.uid()) $$;
    create function client_timezone(p uuid) returns text language sql stable security definer as
      $$ select coalesce((select timezone from clients where id=p),'Europe/London') $$;

    create table client_content_pillars (id uuid primary key default gen_random_uuid(),
      client_id uuid, name text, target_share int default 100, active boolean default true);
    create table client_engine_budgets (client_id uuid, month date, cap_usd numeric,
      primary key (client_id, month));
    create table client_proof_assets (id uuid primary key default gen_random_uuid(), client_id uuid);
    create table client_ideas (id uuid primary key default gen_random_uuid(), client_id uuid, slot_id uuid,
      title text, body text, source_question text, strategic_reason text, content_territory text,
      status text default 'draft', archived_at timestamptz, created_at timestamptz default now());
    create table client_briefs (id uuid primary key default gen_random_uuid());
    create table client_media_assets (id uuid primary key default gen_random_uuid(),
      client_id uuid, title text, storage_path text, render_path text,
      review_status review_status not null default 'pending', human_approved_at timestamptz);
    create table client_asset_reviews (id uuid primary key default gen_random_uuid(),
      asset_id uuid, decision review_status, reason text, reviewed_by uuid,
      created_at timestamptz default now());

    -- The shape 160 extends, as production has it.
    create table scheduled_posts (id uuid primary key default gen_random_uuid(),
      client_id uuid references clients(id), asset_id uuid references client_media_assets(id) on delete set null,
      ref_number text, scheduled_for date, scheduled_at timestamptz,
      channel post_channel not null default 'organic', media_type media_type not null default 'image',
      platform post_platform, notes text, published_at timestamptz, external_id text,
      created_by uuid, created_by_bot text, published_by_bot text, failure_reason text,
      publication_status text not null default 'scheduled'
        check (publication_status in ('scheduled','published','failed')),
      created_at timestamptz not null default now(), updated_at timestamptz not null default now());

    create table client_integrations (id uuid primary key default gen_random_uuid(),
      client_id uuid, provider text, credential_secret_id uuid, status text not null default 'connected',
      unique (client_id, provider));

    create function integration_secret(p_client_id uuid, p_provider text) returns text
      language plpgsql security definer set search_path to 'public','vault' as $$
      declare v uuid; t text; begin
        select credential_secret_id into v from client_integrations
         where client_id = p_client_id and provider = p_provider and status in ('connected','active');
        if v is null then return null; end if;
        select decrypted_secret into t from vault.decrypted_secrets where id = v;
        return t; end; $$;

    create function review_media_asset(p_asset_id uuid, p_decision review_status, p_reason text default null)
      returns void language plpgsql security definer set search_path to 'public' as $$
      begin
        update client_media_assets
           set review_status = p_decision,
               human_approved_at = case when p_decision='approved' then now() else null end
         where id = p_asset_id;
        insert into client_asset_reviews (asset_id, decision, reason, reviewed_by)
        values (p_asset_id, p_decision, p_reason, auth.uid());
      end; $$;

    create table agents (agent_key text primary key, name text, initials text, domain text,
      description text, requires_upstream text[], requires_input boolean default false,
      paused boolean not null default false, archived_at timestamptz);
    insert into agents (agent_key) values ('ideation'),('brief'),('creative_build'),('video_build');
    create table agent_jobs (id uuid primary key default gen_random_uuid(),
      agent_key text references agents(agent_key), client_id uuid, input_table text, input_id uuid,
      created_by uuid, params jsonb default '{}'::jsonb, status text default 'queued',
      cost_usd numeric default 0, created_at timestamptz default clock_timestamp());
    create table agent_job_events (id uuid primary key default gen_random_uuid(),
      job_id uuid, description text, payload jsonb);
    create function can_run_agent(a text,c uuid) returns boolean language sql stable as $$ select true $$;
    create function enqueue_agent_job_internal(p_agent_key text,p_client_id uuid,p_input_table text,
      p_input_id uuid,p_actor uuid,p_params jsonb default '{}'::jsonb,p_description text default 'q')
      returns uuid language plpgsql security definer set search_path to 'public' as $$
      declare v uuid; begin
        insert into agent_jobs (agent_key,client_id,input_table,input_id,created_by,params)
        values (p_agent_key,p_client_id,p_input_table,p_input_id,p_actor,p_params) returning id into v;
        return v; end; $$;
    create function agent_spend_for_client(c uuid,m date) returns numeric language sql stable as
      $$ select 0::numeric $$;
    create view content_archive as select client_id, title, title as idea_title
      from client_media_assets where false;

    insert into auth.users (id) values ('${ADMIN}');
    insert into profiles (id, role) values ('${ADMIN}','admin');
    insert into clients (id, name) values ('${CLIENT}','Harbour'), ('${OTHER}','Beacon');
    insert into client_content_pillars (id, client_id, name) values ('${PILLAR}','${CLIENT}','Proof');
  `);

  for (const f of [
    "20261005210000_146_engine_settings.sql",
    "20261005230000_147_content_slots.sql",
    "20261005190000_145_post_copy.sql",
    "20261006020000_149_plan_slots.sql",
    "20261006040000_150_engine_tick.sql",
    "20261006060000_151_ideas_know_their_slot.sql",
    "20261006080000_152_idea_selection_and_policy.sql",
    "20261006140000_155_tick_queues_the_right_input.sql",
    "20261006200000_158_qa.sql",
    "20261006220000_159_approval_inbox.sql",
    "20261006235000_160_publishing.sql",
  ]) {
    await db.exec(await migration(f));
  }
  await db.exec(`select set_config('request.jwt.claim.sub','${ADMIN}',false);
                 select set_config('request.jwt.claim.role','authenticated',false);`);
});

beforeEach(async () => {
  await db.exec(`reset role;`);
  await db.exec(`delete from post_copy; delete from scheduled_posts; delete from client_asset_reviews;
                 delete from content_slots; delete from client_media_assets; delete from client_ideas;
                 delete from client_integrations; delete from client_engine_settings;`);
  await db.exec(`select set_config('request.jwt.claim.sub','${ADMIN}',false);
                 select set_config('request.jwt.claim.role','authenticated',false);`);
  await db.exec(`select set_engine_settings('${CLIENT}', 14, true)`);
});

describe("the switch is off", () => {
  it("is off for a client already running the engine", async () => {
    // Turning the engine on is a different decision from letting it post.
    const { publishing_enabled } = await one<{ publishing_enabled: boolean }>(
      `select publishing_enabled from client_engine_settings where client_id = '${CLIENT}'`,
    );
    expect(publishing_enabled).toBe(false);
  });

  it("stops a post that is otherwise ready, and says so", async () => {
    const { post } = await publishablePost({ publishing: false });
    expect(await blockerOf(post)).toMatch(/Publishing is off for this client/);
    expect(await asEngine(`select * from claim_posts_for_publishing(5)`)).toHaveLength(0);
  });

  it("is turned on for one client and not the fleet", async () => {
    const { post } = await publishablePost();
    expect(await blockerOf(post)).toBeNull();

    // The other client's settings were never touched by the first one's.
    await db.exec(`select set_engine_settings('${OTHER}', 14, true)`);
    const { publishing_enabled } = await one<{ publishing_enabled: boolean }>(
      `select publishing_enabled from client_engine_settings where client_id = '${OTHER}'`,
    );
    expect(publishing_enabled).toBe(false);
  });

  it("records who turned it on, and keeps that record when it goes off again", async () => {
    await db.exec(`select set_publishing_enabled('${CLIENT}', true)`);
    const on = await one<{ publishing_enabled_by: string | null; publishing_enabled_at: string | null }>(
      `select publishing_enabled_by, publishing_enabled_at from client_engine_settings where client_id = '${CLIENT}'`,
    );
    expect(on.publishing_enabled_by).toBe(ADMIN);
    expect(on.publishing_enabled_at).not.toBeNull();

    await db.exec(`select set_publishing_enabled('${CLIENT}', false)`);
    const off = await one<{ publishing_enabled: boolean; publishing_enabled_by: string | null }>(
      `select publishing_enabled, publishing_enabled_by from client_engine_settings where client_id = '${CLIENT}'`,
    );
    expect(off.publishing_enabled).toBe(false);
    expect(off.publishing_enabled_by).toBe(ADMIN);
  });

  it("is not a setting an outsider can flip", async () => {
    await db.exec(`select set_config('request.jwt.claim.sub','',false)`);
    await expect(db.exec(`select set_publishing_enabled('${CLIENT}', true)`)).rejects.toThrow(/Not permitted/);
  });
});

describe("what is stopping each thing that would not go out", () => {
  it("names the missing human approval", async () => {
    const { post } = await publishablePost({ approved: false });
    expect(await blockerOf(post)).toMatch(/Nobody has approved the asset/);
  });

  it("names the missing caption", async () => {
    const { post } = await publishablePost({ caption: null });
    expect(await blockerOf(post)).toMatch(/no caption for instagram/);
  });

  it("treats an empty caption as no caption", async () => {
    const { post } = await publishablePost({ caption: "   " });
    expect(await blockerOf(post)).toMatch(/no caption/);
  });

  it("names a platform with no adapter instead of staying silent", async () => {
    // The alternative is a LinkedIn post that is simply never claimed, with
    // nothing anywhere saying why.
    const { post } = await publishablePost({ platform: "linkedin", integration: "linkedin" });
    expect(await blockerOf(post)).toMatch(/no adapter for linkedin/);
  });

  it("names the missing integration", async () => {
    const { post } = await publishablePost({ integration: null });
    expect(await blockerOf(post)).toMatch(/No usable instagram integration/);
  });

  it("accepts a connected integration that has never been used", async () => {
    // Migration 156: requiring 'active' deadlocked, because only a
    // successful call writes 'active' and the call needs the token. This is
    // the third place that list is read from, so it is the third place it
    // could drift.
    const { post } = await publishablePost();
    await db.exec(`update client_integrations set status = 'connected' where client_id = '${CLIENT}'`);
    expect(await blockerOf(post)).toBeNull();
  });

  it("refuses an integration whose token is known not to work", async () => {
    const { post } = await publishablePost();
    for (const status of ["error", "expiring", "revoked"]) {
      await db.exec(`update client_integrations set status = '${status}' where client_id = '${CLIENT}'`);
      expect(await blockerOf(post)).toMatch(/No usable instagram integration/);
    }
  });

  it("says a post is not due rather than sending it early", async () => {
    const { post } = await publishablePost({ due: "now() + interval '3 hours'" });
    expect(await blockerOf(post)).toMatch(/Not due yet/);
  });

  it("says an orphaned post can never be published", async () => {
    const { post, asset } = await publishablePost();
    await db.exec(`delete from client_media_assets where id = '${asset}'`);
    expect(await blockerOf(post)).toMatch(/asset is gone/);
  });

  it("reports nothing in the way when there is nothing in the way", async () => {
    const { post } = await publishablePost();
    expect(await blockerOf(post)).toBeNull();
  });
});

describe("claiming", () => {
  it("hands the publisher everything it needs in one go", async () => {
    const { post, asset } = await publishablePost();
    const [claim] = await asEngine<{
      post_id: string;
      asset_id: string;
      provider: string;
      media_path: string;
      caption: string;
      hashtags: string[];
      alt_text: string;
      attempt: number;
    }>(`select * from claim_posts_for_publishing(5)`);
    expect(claim).toMatchObject({
      post_id: post,
      asset_id: asset,
      provider: "instagram",
      caption: "Five steps, one chain.",
      alt_text: "Cards in a row.",
      attempt: 1,
    });
    // The cut, not the source footage.
    expect(claim!.media_path).toBe("assets/cut.mp4");
  });

  it("falls back to the stored file when nothing was rendered", async () => {
    await publishablePost({ renderPath: null });
    const [claim] = await asEngine<{ media_path: string }>(`select * from claim_posts_for_publishing(5)`);
    expect(claim!.media_path).toBe("assets/raw.mp4");
  });

  it("marks the claim so nothing else takes the same post", async () => {
    const { post } = await publishablePost();
    expect(await asEngine(`select * from claim_posts_for_publishing(5)`)).toHaveLength(1);

    const p = await one<{ publication_status: string; publish_attempts: number; publish_claimed_at: string | null }>(
      `select publication_status, publish_attempts, publish_claimed_at from scheduled_posts where id = '${post}'`,
    );
    expect(p.publication_status).toBe("publishing");
    expect(p.publish_attempts).toBe(1);
    expect(p.publish_claimed_at).not.toBeNull();

    // The second publisher gets nothing, which is the whole point.
    expect(await asEngine(`select * from claim_posts_for_publishing(5)`)).toHaveLength(0);
  });

  it("takes the oldest first and no more than asked for", async () => {
    await publishablePost({ due: "now() - interval '3 hours'" });
    await publishablePost({ due: "now() - interval '1 hour'" });
    const first = await asEngine<{ scheduled_at: string }>(`select * from claim_posts_for_publishing(1)`);
    expect(first).toHaveLength(1);
    const second = await asEngine<{ scheduled_at: string }>(`select * from claim_posts_for_publishing(1)`);
    expect(new Date(first[0]!.scheduled_at).getTime()).toBeLessThan(new Date(second[0]!.scheduled_at).getTime());
  });

  it("is the publisher's to call, not a person's", async () => {
    await publishablePost();
    await expect(db.exec(`select * from claim_posts_for_publishing(5)`)).rejects.toThrow(/claimed by the publisher/);
  });

  it("refuses an unbounded claim", async () => {
    await expect(asEngine(`select * from claim_posts_for_publishing(0)`)).rejects.toThrow(/between 1 and 50/);
    await expect(asEngine(`select * from claim_posts_for_publishing(500)`)).rejects.toThrow(/between 1 and 50/);
  });
});

describe("it went out", () => {
  it("records the publication and what to click to see it", async () => {
    const { post } = await publishablePost();
    await asEngine(`select * from claim_posts_for_publishing(5)`);
    await asEngine(`select record_post_published('${post}', 'ig_17900', 'https://instagram.com/p/abc')`);

    const p = await one<{
      publication_status: string;
      published_at: string | null;
      external_id: string;
      external_url: string;
      publish_claimed_at: string | null;
    }>(`select publication_status, published_at, external_id, external_url, publish_claimed_at
          from scheduled_posts where id = '${post}'`);
    expect(p.publication_status).toBe("published");
    expect(p.published_at).not.toBeNull();
    expect(p.external_id).toBe("ig_17900");
    expect(p.external_url).toBe("https://instagram.com/p/abc");
    expect(p.publish_claimed_at).toBeNull();
  });

  it("does not object to being told twice", async () => {
    // A runtime that crashed between the platform call and this write, and
    // was then run again by hand, is telling the truth both times.
    const { post } = await publishablePost();
    await asEngine(`select * from claim_posts_for_publishing(5)`);
    await asEngine(`select record_post_published('${post}', 'ig_1')`);
    await asEngine(`select record_post_published('${post}', 'ig_1')`);
    const { external_id } = await one<{ external_id: string }>(
      `select external_id from scheduled_posts where id = '${post}'`,
    );
    expect(external_id).toBe("ig_1");
  });

  it("refuses a post that was never claimed", async () => {
    const { post } = await publishablePost();
    await expect(asEngine(`select record_post_published('${post}')`)).rejects.toThrow(/Claim it first/);
  });

  it("is the publisher's to call", async () => {
    const { post } = await publishablePost();
    await asEngine(`select * from claim_posts_for_publishing(5)`);
    await expect(db.exec(`select record_post_published('${post}')`)).rejects.toThrow(/recorded by the publisher/);
  });

  it("drops out of the queue once it has gone", async () => {
    const { post } = await publishablePost();
    await asEngine(`select * from claim_posts_for_publishing(5)`);
    await asEngine(`select record_post_published('${post}')`);
    expect(await rows(`select 1 from publish_due where post_id = '${post}'`)).toHaveLength(0);
  });
});

describe("it did not", () => {
  it("puts a retryable failure back in the queue", async () => {
    const { post } = await publishablePost();
    await asEngine(`select * from claim_posts_for_publishing(5)`);
    await asEngine(`select record_post_publish_failure('${post}', 'Rate limited.', true)`);

    const p = await one<{ publication_status: string; failure_reason: string; publish_claimed_at: string | null }>(
      `select publication_status, failure_reason, publish_claimed_at from scheduled_posts where id = '${post}'`,
    );
    expect(p.publication_status).toBe("scheduled");
    expect(p.failure_reason).toBe("Rate limited.");
    expect(p.publish_claimed_at).toBeNull();
    // And it can be taken again.
    expect(await asEngine(`select * from claim_posts_for_publishing(5)`)).toHaveLength(1);
  });

  it("stops retrying at the cap", async () => {
    const { post } = await publishablePost();
    for (let i = 0; i < 3; i += 1) {
      await asEngine(`select * from claim_posts_for_publishing(5)`);
      await asEngine(`select record_post_publish_failure('${post}', 'Rate limited.', true)`);
    }
    const { publication_status } = await one<{ publication_status: string }>(
      `select publication_status from scheduled_posts where id = '${post}'`,
    );
    expect(publication_status).toBe("failed");
  });

  it("fails at once when trying again cannot help", async () => {
    const { post } = await publishablePost();
    await asEngine(`select * from claim_posts_for_publishing(5)`);
    await asEngine(`select record_post_publish_failure('${post}', 'The token was revoked.', false)`);
    const { publication_status, publish_attempts } = await one<{
      publication_status: string;
      publish_attempts: number;
    }>(`select publication_status, publish_attempts from scheduled_posts where id = '${post}'`);
    expect(publication_status).toBe("failed");
    expect(publish_attempts).toBe(1);
  });

  it("insists on a reason, because a person reads it", async () => {
    const { post } = await publishablePost();
    await asEngine(`select * from claim_posts_for_publishing(5)`);
    await expect(asEngine(`select record_post_publish_failure('${post}', '   ')`)).rejects.toThrow(/Say why it failed/);
  });

  it("will not call a published post failed", async () => {
    // The post is out. Saying otherwise on the board would be a lie about a
    // real account.
    const { post } = await publishablePost();
    await asEngine(`select * from claim_posts_for_publishing(5)`);
    await asEngine(`select record_post_published('${post}')`);
    await expect(asEngine(`select record_post_publish_failure('${post}', 'Something broke after.', false)`)).rejects.toThrow(
      /already published/,
    );
  });
});

describe("a runtime that died mid-publish", () => {
  it("fails the post and does not retry it", async () => {
    // The decision this whole migration turns on. A crash after the platform
    // call and a crash before it look the same from here, and only one of
    // the two guesses can be undone.
    const { post } = await publishablePost();
    await asEngine(`select * from claim_posts_for_publishing(5)`);
    await db.exec(`update scheduled_posts set publish_claimed_at = now() - interval '2 hours' where id = '${post}'`);

    const reaped = await asEngine<{ reap_stale_publish_claims: number }>(`select reap_stale_publish_claims()`);
    expect(reaped[0]!.reap_stale_publish_claims).toBe(1);

    const p = await one<{ publication_status: string; failure_reason: string }>(
      `select publication_status, failure_reason from scheduled_posts where id = '${post}'`,
    );
    expect(p.publication_status).toBe("failed");
    expect(p.failure_reason).toMatch(/may have gone out/);
    // Explicitly not back in the queue.
    expect(await asEngine(`select * from claim_posts_for_publishing(5)`)).toHaveLength(0);
  });

  it("leaves a claim that is still young alone", async () => {
    const { post } = await publishablePost();
    await asEngine(`select * from claim_posts_for_publishing(5)`);
    const reaped = await asEngine<{ reap_stale_publish_claims: number }>(`select reap_stale_publish_claims()`);
    expect(reaped[0]!.reap_stale_publish_claims).toBe(0);
    const { publication_status } = await one<{ publication_status: string }>(
      `select publication_status from scheduled_posts where id = '${post}'`,
    );
    expect(publication_status).toBe("publishing");
  });

  it("is scheduled to run on its own", async () => {
    const { count } = await one<{ count: number }>(
      `select count(*)::int as count from cron.job where jobname = 'reap-stale-publish-claims'`,
    );
    expect(count).toBe(1);
  });
});

describe("approval to published, end to end", () => {
  it("walks one slot the whole way and leaves it published", async () => {
    // The two halves of the chain joined: 159 creates the post from an
    // approval, 160 sends it and moves the slot. Nothing in between is by
    // hand.
    const { id: asset } = await one<{ id: string }>(
      `insert into client_media_assets (client_id, title, storage_path)
       values ('${CLIENT}','Built','assets/raw.mp4') returning id`,
    );
    const { id: idea } = await one<{ id: string }>(
      `insert into client_ideas (client_id) values ('${CLIENT}') returning id`,
    );
    const { id: slot } = await one<{ id: string }>(
      `select id from create_content_slot('${CLIENT}','instagram', now() - interval '1 hour','${PILLAR}')`,
    );
    await db.exec(`
      select advance_slot('${slot}','ideating'::slot_stage,'engine');
      select advance_slot('${slot}','idea_selected'::slot_stage,'policy',null,null,null,null,'${idea}');
      select advance_slot('${slot}','briefing'::slot_stage,'engine');
      select advance_slot('${slot}','building'::slot_stage,'agent');
      select advance_slot('${slot}','copywriting'::slot_stage,'agent',null,null,null,null,null,null,'${asset}');
      select advance_slot('${slot}','qa'::slot_stage,'agent');
      insert into post_copy (asset_id, platform, caption, source)
      values ('${asset}','instagram','Five steps, one chain.','agent');
      insert into client_integrations (client_id, provider, credential_secret_id, status)
      values ('${CLIENT}','instagram','${SECRET}','connected');
      select set_publishing_enabled('${CLIENT}', true);`);
    await asEngine(`select record_qa_result('${slot}', 100, '[]'::jsonb, 'awaiting_approval'::slot_stage)`);
    await db.exec(`select approve_slot('${slot}', 'Looks right.')`);

    const [claim] = await asEngine<{ post_id: string; caption: string }>(
      `select * from claim_posts_for_publishing(5)`,
    );
    expect(claim!.caption).toBe("Five steps, one chain.");
    await asEngine(`select record_post_published('${claim!.post_id}', 'ig_2', 'https://instagram.com/p/xyz')`);

    const s = await one<{ stage: string }>(`select stage from content_slots where id = '${slot}'`);
    expect(s.stage).toBe("published");
    const { note } = await one<{ note: string }>(
      `select note from slot_events where slot_id = '${slot}' and to_stage = 'published'`,
    );
    expect(note).toMatch(/instagram\.com\/p\/xyz/);
  });

  it("fails the slot when the post cannot go out at all", async () => {
    const { id: asset } = await one<{ id: string }>(
      `insert into client_media_assets (client_id, title, storage_path)
       values ('${CLIENT}','Built','assets/raw.mp4') returning id`,
    );
    const { id: slot } = await one<{ id: string }>(
      `select id from create_content_slot('${CLIENT}','instagram', now() - interval '1 hour','${PILLAR}')`,
    );
    await db.exec(`
      select advance_slot('${slot}','ideating'::slot_stage,'engine');
      select advance_slot('${slot}','idea_selected'::slot_stage,'policy');
      select advance_slot('${slot}','briefing'::slot_stage,'engine');
      select advance_slot('${slot}','building'::slot_stage,'agent');
      select advance_slot('${slot}','copywriting'::slot_stage,'agent',null,null,null,null,null,null,'${asset}');
      select advance_slot('${slot}','qa'::slot_stage,'agent');
      insert into post_copy (asset_id, platform, caption, source)
      values ('${asset}','instagram','Five steps.','agent');
      insert into client_integrations (client_id, provider, credential_secret_id, status)
      values ('${CLIENT}','instagram','${SECRET}','connected');
      select set_publishing_enabled('${CLIENT}', true);`);
    await asEngine(`select record_qa_result('${slot}', 100, '[]'::jsonb, 'awaiting_approval'::slot_stage)`);
    await db.exec(`select approve_slot('${slot}')`);
    const { scheduled_post_id: post } = await one<{ scheduled_post_id: string }>(
      `select scheduled_post_id from content_slots where id = '${slot}'`,
    );

    await asEngine(`select * from claim_posts_for_publishing(5)`);
    await asEngine(`select record_post_publish_failure('${post}', 'The account was disconnected.', false)`);

    const s = await one<{ stage: string; blocked_reason: string }>(
      `select stage, blocked_reason from content_slots where id = '${slot}'`,
    );
    expect(s.stage).toBe("failed");
    expect(s.blocked_reason).toMatch(/account was disconnected/);
  });

  it("leaves the slot alone while the post is still being retried", async () => {
    // A red card in front of a person for something about to be tried again
    // is a red card that teaches them to ignore red cards.
    const { post } = await publishablePost();
    const { id: slot } = await one<{ id: string }>(
      `select id from create_content_slot('${CLIENT}','facebook', now() - interval '1 hour','${PILLAR}')`,
    );
    await db.exec(`
      select advance_slot('${slot}','ideating'::slot_stage,'engine');
      select advance_slot('${slot}','idea_selected'::slot_stage,'policy');
      select advance_slot('${slot}','briefing'::slot_stage,'engine');
      select advance_slot('${slot}','building'::slot_stage,'agent');
      select advance_slot('${slot}','copywriting'::slot_stage,'agent');
      select advance_slot('${slot}','qa'::slot_stage,'agent');`);
    await asEngine(`select record_qa_result('${slot}', 100, '[]'::jsonb, 'awaiting_approval'::slot_stage)`);
    await db.exec(`update content_slots set scheduled_post_id = '${post}' where id = '${slot}'`);
    await asEngine(`select advance_slot('${slot}','scheduled'::slot_stage,'human')`);

    await asEngine(`select * from claim_posts_for_publishing(5)`);
    await asEngine(`select record_post_publish_failure('${post}', 'Rate limited.', true)`);
    const { stage } = await one<{ stage: string }>(`select stage from content_slots where id = '${slot}'`);
    expect(stage).toBe("scheduled");
  });
});

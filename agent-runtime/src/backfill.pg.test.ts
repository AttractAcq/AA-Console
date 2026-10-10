import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 165 against a real Postgres.
 *
 * enqueue_metrics_ingest_jobs takes a window and nothing ever passed it one,
 * so the only history this system has ever pulled is the trailing seven days
 * — every morning, for every client at once. A client connected in October
 * has no September.
 *
 * The case that matters most is the one the Integrations panel already
 * claims to support and did not: pulling history without arming the daily
 * schedule. enqueue_metrics_ingest_jobs requires ingest_enabled, so the one
 * thing that comment describes was the one thing it refused.
 */
let db: PGlite;

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STAFF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECRET = "55555555-5555-4555-8555-555555555555";

async function one<T = Record<string, unknown>>(sql: string): Promise<T> {
  return (await db.query<T>(sql)).rows[0]!;
}
async function rows<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return (await db.query<T>(sql)).rows;
}
async function as<T = Record<string, unknown>>(sub: string, sql: string): Promise<T[]> {
  await db.exec(`select set_config('request.jwt.claim.sub','${sub}',false);`);
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec(`select set_config('request.jwt.claim.sub','${ADMIN}',false);`);
  }
}

async function integration(
  provider: string,
  over: { client?: string; status?: string; ingest?: boolean; secret?: boolean } = {},
) {
  await db.exec(`insert into client_integrations (client_id, provider, credential_secret_id, status, ingest_enabled)
                 values ('${over.client ?? CLIENT}','${provider}',
                         ${over.secret === false ? "null" : `'${SECRET}'`},
                         '${over.status ?? "connected"}',
                         ${over.ingest ?? true})
                 on conflict (client_id, provider) do update
                   set status = excluded.status, ingest_enabled = excluded.ingest_enabled,
                       credential_secret_id = excluded.credential_secret_id`);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;

    create type job_status as enum ('queued','paused','claimed','running','completed','failed','cancelled');
    create type metric_surface as enum ('paid','organic');
    create type metric_entity as enum ('account','campaign','post');
    create type metric_basis as enum ('daily','cumulative');

    create table clients (id uuid primary key, name text);
    create table profiles (id uuid primary key, role text);
    create table client_members (client_id uuid, user_id uuid);
    create function is_admin() returns boolean language sql stable security definer as
      $$ select exists (select 1 from profiles where id = auth.uid() and role='admin') $$;
    create function can_access_client(p uuid) returns boolean language sql stable security definer as
      $$ select is_admin() or exists (select 1 from client_members m
            where m.client_id=p and m.user_id=auth.uid()) $$;

    create table agents (agent_key text primary key, name text,
      paused boolean not null default false, archived_at timestamptz);
    insert into agents (agent_key, name) values ('metrics_ingest','Metrics Ingest');
    create table agent_jobs (id uuid primary key default gen_random_uuid(),
      agent_key text references agents(agent_key), client_id uuid, created_by uuid,
      status job_status not null default 'queued', error text,
      params jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default clock_timestamp(), completed_at timestamptz);

    create table client_integrations (id uuid primary key default gen_random_uuid(),
      client_id uuid, provider text, credential_secret_id uuid,
      status text not null default 'connected', ingest_enabled boolean not null default true,
      unique (client_id, provider));

    create table metrics_daily (id uuid primary key default gen_random_uuid(),
      client_id uuid, surface metric_surface, entity_type metric_entity, external_id text,
      metric_date date, campaign_id uuid, post_id uuid,
      impressions bigint, reach bigint, clicks bigint, engagements bigint,
      spend numeric, conversions bigint, raw jsonb,
      fetched_at timestamptz default now(), basis metric_basis, currency text);

    create function lock_down_definer_functions() returns integer language sql as $$ select 0 $$;

    insert into auth.users (id) values ('${ADMIN}'), ('${STAFF}');
    insert into profiles (id, role) values ('${ADMIN}','admin'), ('${STAFF}','staff');
    insert into clients (id, name) values ('${CLIENT}','Harbour'), ('${OTHER}','Beacon');
    insert into client_members (client_id, user_id) values ('${OTHER}','${STAFF}');
  `);

  await db.exec(await migration("20261007130000_165_a_backfill_can_be_asked_for.sql"));
  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
                 select set_config('request.jwt.claim.sub','${ADMIN}',false);`);
});

beforeEach(async () => {
  await db.exec(`delete from agent_jobs; delete from client_integrations; delete from metrics_daily;`);
  await db.exec(`select set_config('request.jwt.claim.role','authenticated',false);
                 select set_config('request.jwt.claim.sub','${ADMIN}',false);`);
});

describe("asking for a window", () => {
  it("queues one pull per surface, carrying the window asked for", async () => {
    await integration("meta");
    await integration("instagram");
    const ids = await rows<{ request_metrics_backfill: string }>(
      `select request_metrics_backfill('${CLIENT}', date '2026-09-01', date '2026-09-30')`,
    );
    expect(ids).toHaveLength(2);

    const queued = await rows<{ surface: string; since: string; until: string; asked_for_by_hand: boolean }>(
      // ::text because PGlite hands a `date` back as a JS Date, where
      // PostgREST sends the ISO string the panel actually reads.
      `select surface, since::text, until::text, asked_for_by_hand from metrics_pulls order by surface`,
    );
    expect(queued.map((r) => r.surface)).toEqual(["organic", "paid"]);
    for (const row of queued) {
      expect(row.since).toBe("2026-09-01");
      expect(row.until).toBe("2026-09-30");
      // So the panel can tell a person's request from the schedule's.
      expect(row.asked_for_by_hand).toBe(true);
    }
  });

  it("can ask for one surface on its own", async () => {
    await integration("meta");
    await integration("instagram");
    await db.exec(`select request_metrics_backfill('${CLIENT}', date '2026-09-01', date '2026-09-07', 'paid')`);
    const queued = await rows<{ surface: string }>(`select surface from metrics_pulls`);
    expect(queued.map((r) => r.surface)).toEqual(["paid"]);
  });

  it("records who asked", async () => {
    await integration("meta");
    await db.exec(`select request_metrics_backfill('${CLIENT}', date '2026-09-01', date '2026-09-07')`);
    const { created_by } = await one<{ created_by: string }>(`select created_by from agent_jobs`);
    expect(created_by).toBe(ADMIN);
  });
});

describe("the switch it deliberately ignores", () => {
  it("pulls history for an integration whose daily schedule is off", async () => {
    // The Integrations panel says this is what the switch is for -- "the
    // ingest can still be run by hand, which is what you want for a one-off
    // backfill without arming a recurring job" -- and until now it was the
    // one case that was refused.
    await integration("meta", { ingest: false });
    const ids = await rows(`select request_metrics_backfill('${CLIENT}', date '2026-09-01', date '2026-09-07')`);
    expect(ids).toHaveLength(1);
  });

  it("still refuses an integration whose token is known not to work", async () => {
    await integration("meta", { status: "error" });
    await expect(
      db.exec(`select request_metrics_backfill('${CLIENT}', date '2026-09-01', date '2026-09-07')`),
    ).rejects.toThrow(/no usable integration/);
  });

  it("still refuses an integration with no credential stored", async () => {
    await integration("meta", { secret: false });
    await expect(
      db.exec(`select request_metrics_backfill('${CLIENT}', date '2026-09-01', date '2026-09-07')`),
    ).rejects.toThrow(/no usable integration/);
  });

  it("accepts an expiring token, which still works", async () => {
    await integration("meta", { status: "expiring" });
    expect(
      await rows(`select request_metrics_backfill('${CLIENT}', date '2026-09-01', date '2026-09-07')`),
    ).toHaveLength(1);
  });
});

describe("the window", () => {
  it("refuses a window that starts after it ends", async () => {
    await integration("meta");
    await expect(
      db.exec(`select request_metrics_backfill('${CLIENT}', date '2026-09-30', date '2026-09-01')`),
    ).rejects.toThrow(/starts after it ends/);
  });

  it("refuses a window ending in the future", async () => {
    await integration("meta");
    await expect(
      db.exec(`select request_metrics_backfill('${CLIENT}', current_date, current_date + 5)`),
    ).rejects.toThrow(/ends in the future/);
  });

  it("states the cap rather than quietly cutting the window to it", async () => {
    // A request silently clamped looks like a complete backfill and is not
    // one, and the hole turns up months later in a chart.
    await integration("meta");
    await expect(
      db.exec(
        `select request_metrics_backfill('${CLIENT}', current_date - 500, current_date)`,
      ),
    ).rejects.toThrow(/at most 400: split it into several/);
  });

  it("allows exactly the cap", async () => {
    await integration("meta");
    const ids = await rows(
      `select request_metrics_backfill('${CLIENT}', current_date - 399, current_date)`,
    );
    expect(ids).toHaveLength(1);
  });

  it("allows a single day", async () => {
    await integration("meta");
    expect(
      await rows(`select request_metrics_backfill('${CLIENT}', date '2026-09-10', date '2026-09-10')`),
    ).toHaveLength(1);
  });

  it("refuses a half-stated window", async () => {
    await integration("meta");
    await expect(
      db.exec(`select request_metrics_backfill('${CLIENT}', null, current_date)`),
    ).rejects.toThrow(/both ends of the window/);
  });

  it("refuses a surface it cannot pull", async () => {
    await integration("meta");
    await expect(
      db.exec(`select request_metrics_backfill('${CLIENT}', date '2026-09-01', date '2026-09-07', 'tiktok')`),
    ).rejects.toThrow(/Unknown surface "tiktok"/);
  });
});

describe("not paying for the same month twice", () => {
  it("refuses the same window while it is still being pulled", async () => {
    await integration("meta");
    await db.exec(`select request_metrics_backfill('${CLIENT}', date '2026-09-01', date '2026-09-30')`);
    await expect(
      db.exec(`select request_metrics_backfill('${CLIENT}', date '2026-09-01', date '2026-09-30')`),
    ).rejects.toThrow(/already being pulled/);
  });

  it("allows a different window while one is running", async () => {
    // The daily job's guard is "anything in flight for this surface", which
    // would put a backfill behind the morning pull. This one is per window.
    await integration("meta");
    await db.exec(`select request_metrics_backfill('${CLIENT}', date '2026-09-01', date '2026-09-30')`);
    expect(
      await rows(`select request_metrics_backfill('${CLIENT}', date '2026-08-01', date '2026-08-31')`),
    ).toHaveLength(1);
  });

  it("allows the same window again once the first finished", async () => {
    // Meta's figures move for about a week, so re-pulling a window on
    // purpose is a legitimate thing to want.
    await integration("meta");
    await db.exec(`select request_metrics_backfill('${CLIENT}', date '2026-09-01', date '2026-09-30')`);
    await db.exec(`update agent_jobs set status = 'completed', completed_at = now()`);
    expect(
      await rows(`select request_metrics_backfill('${CLIENT}', date '2026-09-01', date '2026-09-30')`),
    ).toHaveLength(1);
  });

  it("counts a held job as still being pulled", async () => {
    await integration("meta");
    await db.exec(`select request_metrics_backfill('${CLIENT}', date '2026-09-01', date '2026-09-30')`);
    await db.exec(`update agent_jobs set status = 'paused', error = 'Over cap.'`);
    await expect(
      db.exec(`select request_metrics_backfill('${CLIENT}', date '2026-09-01', date '2026-09-30')`),
    ).rejects.toThrow(/already being pulled/);
  });
});

describe("who may ask", () => {
  it("refuses a client the caller cannot reach", async () => {
    await integration("meta");
    await expect(
      as(STAFF, `select request_metrics_backfill('${CLIENT}', date '2026-09-01', date '2026-09-07')`),
    ).rejects.toThrow(/Not permitted for this client/);
  });

  it("allows a client the caller can reach", async () => {
    await integration("meta", { client: OTHER });
    expect(
      await as(STAFF, `select request_metrics_backfill('${OTHER}', date '2026-09-01', date '2026-09-07')`),
    ).toHaveLength(1);
  });
});

describe("what history is already here", () => {
  it("says the span and how many days are in it", async () => {
    await db.exec(`insert into metrics_daily (client_id, surface, entity_type, metric_date, basis)
                   values ('${CLIENT}','paid','campaign', date '2026-09-01','daily'),
                          ('${CLIENT}','paid','campaign', date '2026-09-02','daily'),
                          ('${CLIENT}','paid','campaign', date '2026-09-05','daily')`);
    const c = await one<{
      first_day: string;
      last_day: string;
      days_with_data: number;
      days_missing_inside: number;
    }>(`select first_day::text, last_day::text, days_with_data, days_missing_inside
          from metrics_coverage where client_id = '${CLIENT}' and surface = 'paid'`);
    expect(c.first_day).toBe("2026-09-01");
    expect(c.last_day).toBe("2026-09-05");
    expect(c.days_with_data).toBe(3);
    // A gap in the middle is a failed pull; a short span is a young
    // integration, and the two want different actions.
    expect(c.days_missing_inside).toBe(2);
  });

  it("counts a complete span as having no gaps", async () => {
    await db.exec(`insert into metrics_daily (client_id, surface, entity_type, metric_date, basis)
                   select '${CLIENT}','organic','account', d::date,'daily'
                     from generate_series(date '2026-09-01', date '2026-09-07', interval '1 day') d`);
    const { days_missing_inside, days_with_data } = await one<{
      days_missing_inside: number;
      days_with_data: number;
    }>(`select days_missing_inside, days_with_data from metrics_coverage
         where client_id = '${CLIENT}' and surface = 'organic'`);
    expect(days_with_data).toBe(7);
    expect(days_missing_inside).toBe(0);
  });

  it("does not count the same day twice because two entities reported it", async () => {
    await db.exec(`insert into metrics_daily (client_id, surface, entity_type, external_id, metric_date, basis)
                   values ('${CLIENT}','paid','campaign','a', date '2026-09-01','daily'),
                          ('${CLIENT}','paid','campaign','b', date '2026-09-01','daily')`);
    const { days_with_data } = await one<{ days_with_data: number }>(
      `select days_with_data from metrics_coverage where client_id = '${CLIENT}'`,
    );
    expect(days_with_data).toBe(1);
  });

  it("says nothing about a client with no metrics", async () => {
    expect(await rows(`select 1 from metrics_coverage where client_id = '${CLIENT}'`)).toHaveLength(0);
  });
});

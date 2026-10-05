import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 144 against a real Postgres.
 *
 * Scheduling was date-only, and distribution_due compared that date against
 * CURRENT_DATE, which on Supabase is UTC. So "today" was the server's today:
 * a London client in summer had an hour each evening where the board said
 * tomorrow, and a client further east would have had a whole day of it.
 *
 * The migration itself is applied here, not a copy of it, so the fixture
 * stubs whatever 144 touches but does not test — can_access_client and the
 * mcp_internal bot guards. Everything the timezone work depends on is real.
 */
let db: PGlite;

const migration = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

const LONDON = "11111111-1111-4111-8111-111111111111";
const AUCKLAND = "22222222-2222-4222-8222-222222222222";
/** state reads 'orphaned' before it reads any date, so a dated case needs a real asset. */
const NZ_ASSET = "33333333-3333-4333-8333-333333333333";

/** 2026 UK clock changes: forward 29 March 01:00, back 25 October 02:00. */
const GMT_DAY = "2026-01-15";
const SPRING_FORWARD = "2026-03-29";
const BST_DAY = "2026-07-04";
const FALL_BACK = "2026-10-25";

async function one<T = Record<string, unknown>>(sql: string): Promise<T> {
  const result = await db.query<T>(sql);
  return result.rows[0]!;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema mcp_internal;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    create type media_type as enum ('image', 'text', 'video');
    create type content_format as enum ('single', 'carousel', 'story', 'reel');
    create type review_status as enum ('pending', 'approved', 'rejected');
    create type post_channel as enum ('organic', 'paid');
    create type post_platform as enum ('facebook', 'instagram', 'tiktok', 'linkedin', 'youtube');

    create table clients (id uuid primary key, name text not null default 'c');

    create table client_media_assets (
      id uuid primary key,
      client_id uuid not null references clients(id),
      ref_number text,
      title text,
      media_type media_type not null default 'image',
      content_format content_format not null default 'single',
      review_status review_status not null default 'approved',
      human_approved_at timestamptz
    );

    create table scheduled_posts (
      id uuid primary key default gen_random_uuid(),
      client_id uuid,
      asset_id uuid references client_media_assets(id),
      ref_number text,
      scheduled_for date not null,
      channel post_channel not null default 'organic',
      media_type media_type not null default 'image',
      platform post_platform,
      notes text,
      published_at timestamptz,
      created_by uuid,
      created_by_bot text,
      publication_status text not null default 'scheduled',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    -- The trigger as it stood before 144: asset fields only.
    create function sync_scheduled_post_from_asset() returns trigger
      language plpgsql security definer set search_path to 'public' as $$
      begin
        if new.asset_id is not null then
          select a.ref_number, a.media_type, a.client_id
            into new.ref_number, new.media_type, new.client_id
            from client_media_assets a where a.id = new.asset_id;
        end if;
        return new;
      end; $$;
    create trigger sp_sync_asset before insert or update on scheduled_posts
      for each row execute function sync_scheduled_post_from_asset();

    -- The view exactly as migration 123 left it. 144 uses create or replace,
    -- which may add columns but may not rename or reorder the existing ones,
    -- so the shape it has to be compatible with has to be the real one.
    create view distribution_due as
    select sp.client_id, sp.id as schedule_id, sp.asset_id, sp.ref_number, sp.scheduled_for,
      sp.channel::text as channel, sp.platform::text as platform, sp.media_type::text as media_type,
      a.title as asset_title, a.content_format::text as content_format,
      case
        when sp.asset_id is null or a.id is null then 'orphaned'
        when sp.scheduled_for < current_date then 'overdue'
        when sp.scheduled_for = current_date then 'due_today'
        else 'upcoming'
      end as state,
      greatest(current_date - sp.scheduled_for, 0) as days_late,
      coalesce(a.human_approved_at is not null, false) as human_approved
    from scheduled_posts sp
    left join client_media_assets a on a.id = sp.asset_id
    where sp.publication_status = 'scheduled' and sp.published_at is null;

    -- Stubs: 144 redefines functions that guard on these, but the guards are
    -- not what this test is about.
    create function can_access_client(uuid) returns boolean language sql stable as $$ select true $$;
    create function mcp_internal.require_active_bot(text) returns void language sql as $$ select $$;
    create function mcp_internal.require_bot_client_grant(text, uuid) returns void language sql as $$ select $$;
    create function mcp_internal.require_mcp_ids(text, text) returns void language sql as $$ select $$;
    create function mcp_internal.require_service_role() returns void language sql as $$ select $$;
    create function mcp_internal.take_content_request(text, text, text, uuid, jsonb)
      returns jsonb language sql as $$ select null::jsonb $$;
    create table mcp_internal.mcp_content_requests (
      bot_id text, execution_id text, request_id text, tool text, client_id uuid,
      asset_id uuid, schedule_id uuid, payload jsonb, result jsonb
    );
  `);

  // Rows that exist before the migration: date-only, as everything was.
  await db.exec(`
    insert into clients (id, name) values ('${LONDON}', 'London'), ('${AUCKLAND}', 'Auckland');
    insert into client_media_assets (id, client_id, title, human_approved_at)
      values ('${NZ_ASSET}', '${AUCKLAND}', 'A post', now());
    insert into scheduled_posts (client_id, scheduled_for) values
      ('${LONDON}', '${GMT_DAY}'), ('${LONDON}', '${SPRING_FORWARD}'),
      ('${LONDON}', '${BST_DAY}'), ('${LONDON}', '${FALL_BACK}');
  `);

  await db.exec(await migration("20261005120000_144_post_time_and_timezone.sql"));
  // Auckland is set after the migration, through the column it adds.
  await db.exec(`update clients set timezone = 'Pacific/Auckland' where id = '${AUCKLAND}';`);
});

describe("the backfill", () => {
  it("puts every existing post at 09:00 on the day it already had", async () => {
    const rows = await db.query<{ scheduled_for: string; local: string }>(`
      select scheduled_for::text as scheduled_for,
             to_char(scheduled_at at time zone 'Europe/London', 'YYYY-MM-DD HH24:MI') as local
      from scheduled_posts order by scheduled_for`);
    expect(rows.rows.map((r) => r.local)).toEqual([
      `${GMT_DAY} 09:00`,
      `${SPRING_FORWARD} 09:00`,
      `${BST_DAY} 09:00`,
      `${FALL_BACK} 09:00`,
    ]);
  });

  it("means a different UTC instant in winter and in summer", async () => {
    // 09:00 GMT is 09:00Z. 09:00 BST is 08:00Z. A date-only schedule could
    // not express that difference, which is the whole point.
    const rows = await db.query<{ utc: string }>(`
      select to_char(scheduled_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as utc
      from scheduled_posts where scheduled_for in ('${GMT_DAY}', '${BST_DAY}')
      order by scheduled_for`);
    expect(rows.rows.map((r) => r.utc)).toEqual([`${GMT_DAY} 09:00`, `${BST_DAY} 08:00`]);
  });

  it("leaves no post without an instant", async () => {
    const { n } = await one<{ n: number }>(`select count(*)::int as n from scheduled_posts where scheduled_at is null`);
    expect(n).toBe(0);
  });
});

describe("a client's timezone", () => {
  it("defaults to Europe/London", async () => {
    const { timezone } = await one<{ timezone: string }>(`select timezone from clients where id = '${LONDON}'`);
    expect(timezone).toBe("Europe/London");
  });

  it("refuses anything that is not an IANA name", async () => {
    await expect(db.exec(`update clients set timezone = 'GMT+1' where id = '${LONDON}'`)).rejects.toThrow(
      /not an IANA timezone name/,
    );
    await expect(db.exec(`update clients set timezone = '' where id = '${LONDON}'`)).rejects.toThrow(/needs a timezone/);
  });

  it("falls back rather than failing for a client that is not there", async () => {
    const { tz } = await one<{ tz: string }>(`select client_timezone(gen_random_uuid()) as tz`);
    expect(tz).toBe("Europe/London");
  });
});

describe("writing one column and getting the other", () => {
  beforeEach(async () => {
    await db.exec(`delete from scheduled_posts where client_id = '${AUCKLAND}'`);
  });

  it("gives a date-only insert the default hour in the client's own zone", async () => {
    await db.exec(`insert into scheduled_posts (client_id, scheduled_for) values ('${AUCKLAND}', '${BST_DAY}')`);
    const { local } = await one<{ local: string }>(`
      select to_char(scheduled_at at time zone 'Pacific/Auckland', 'YYYY-MM-DD HH24:MI') as local
      from scheduled_posts where client_id = '${AUCKLAND}'`);
    expect(local).toBe(`${BST_DAY} 09:00`);
  });

  it("derives the local date from an instant, even when UTC is on another day", async () => {
    // 09:00 NZST on 4 July is 21:00Z on 3 July. The local date is what the
    // board shows, so it has to be the 4th.
    await db.exec(`
      insert into scheduled_posts (client_id, scheduled_at)
      values ('${AUCKLAND}', timestamptz '${BST_DAY} 09:00 Pacific/Auckland')`);
    const { scheduled_for, utc } = await one<{ scheduled_for: string; utc: string }>(`
      select scheduled_for::text as scheduled_for,
             to_char(scheduled_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as utc
      from scheduled_posts where client_id = '${AUCKLAND}'`);
    expect(scheduled_for).toBe(BST_DAY);
    expect(utc).toBe("2026-07-03 21:00");
  });

  it("refuses an insert with neither", async () => {
    await expect(
      db.exec(`insert into scheduled_posts (client_id, scheduled_for) values ('${AUCKLAND}', null)`),
    ).rejects.toThrow(/needs either a date or a time/);
  });

  it("moves the date when the instant moves", async () => {
    await db.exec(`insert into scheduled_posts (client_id, scheduled_for) values ('${AUCKLAND}', '${BST_DAY}')`);
    await db.exec(`
      update scheduled_posts set scheduled_at = timestamptz '2026-07-09 18:30 Pacific/Auckland'
      where client_id = '${AUCKLAND}'`);
    const { scheduled_for } = await one<{ scheduled_for: string }>(
      `select scheduled_for::text as scheduled_for from scheduled_posts where client_id = '${AUCKLAND}'`,
    );
    expect(scheduled_for).toBe("2026-07-09");
  });

  it("keeps the time of day when the board drags a post to another date", async () => {
    await db.exec(`
      insert into scheduled_posts (client_id, scheduled_at)
      values ('${AUCKLAND}', timestamptz '${BST_DAY} 18:30 Pacific/Auckland')`);
    await db.exec(`update scheduled_posts set scheduled_for = '2026-07-09' where client_id = '${AUCKLAND}'`);
    const { local } = await one<{ local: string }>(`
      select to_char(scheduled_at at time zone 'Pacific/Auckland', 'YYYY-MM-DD HH24:MI') as local
      from scheduled_posts where client_id = '${AUCKLAND}'`);
    // 18:30, not reset to the 09:00 default.
    expect(local).toBe("2026-07-09 18:30");
  });
});

describe("the clocks changing", () => {
  beforeEach(async () => {
    await db.exec(`delete from scheduled_posts where client_id = '${AUCKLAND}'`);
  });

  it("keeps 09:00 local across the spring forward and the autumn back", async () => {
    // The same wall-clock hour on either side of a clock change is a
    // different UTC instant. A date-only column had no way to say so.
    const rows = await db.query<{ utc: string }>(`
      select to_char(scheduled_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as utc
      from scheduled_posts where client_id = '${LONDON}'
        and scheduled_for in ('${SPRING_FORWARD}', '${FALL_BACK}') order by scheduled_for`);
    // 29 March 09:00 is already BST (+1). 25 October 09:00 is back to GMT.
    expect(rows.rows.map((r) => r.utc)).toEqual([`${SPRING_FORWARD} 08:00`, `${FALL_BACK} 09:00`]);
  });

  it("still lands on the right local date for an hour that does not exist", async () => {
    // 01:30 on the spring-forward morning never happens in London. Postgres
    // resolves it rather than erroring; what matters here is that the date
    // the board shows is still the 29th.
    await db.exec(`
      insert into scheduled_posts (client_id, scheduled_at)
      values ('${LONDON}', timestamptz '${SPRING_FORWARD} 01:30 Europe/London')`);
    const { scheduled_for } = await one<{ scheduled_for: string }>(`
      select scheduled_for::text as scheduled_for from scheduled_posts
      where client_id = '${LONDON}' order by created_at desc limit 1`);
    expect(scheduled_for).toBe(SPRING_FORWARD);
    await db.exec(`delete from scheduled_posts where scheduled_at = timestamptz '${SPRING_FORWARD} 01:30 Europe/London'`);
  });
});

describe("distribution_due", () => {
  beforeEach(async () => {
    await db.exec(`delete from scheduled_posts where client_id = '${AUCKLAND}'`);
  });

  it("says due_now once the instant has passed, and not before", async () => {
    await db.exec(`
      insert into scheduled_posts (client_id, scheduled_at) values
        ('${AUCKLAND}', now() - interval '1 hour'),
        ('${AUCKLAND}', now() + interval '1 hour')`);
    const rows = await db.query<{ due_now: boolean }>(`
      select due_now from distribution_due where client_id = '${AUCKLAND}' order by scheduled_at`);
    expect(rows.rows.map((r) => r.due_now)).toEqual([true, false]);
  });

  it("reads today from the client's clock, not the server's", async () => {
    // The bug this migration exists for, and a test that has to work at any
    // hour. Every zone shares UTC's date for part of the day, so picking one
    // zone would make this pass or fail depending on when CI ran: at 10:42
    // UTC, Auckland is already 23:42 on the same date and the two are
    // indistinguishable. So pick, now, a zone whose local date differs from
    // UTC's — one of the far east or the far west always does — and assert
    // that it differs before relying on it.
    const { zone, local_today, utc_today } = await one<{
      zone: string;
      local_today: string;
      utc_today: string;
    }>(`
      select zone,
             (now() at time zone zone)::date::text as local_today,
             current_date::text as utc_today
      from unnest(array['Pacific/Kiritimati', 'Pacific/Midway', 'Pacific/Auckland', 'America/Anchorage']) as zone
      where (now() at time zone zone)::date <> current_date
      limit 1`);
    expect(zone).toBeTruthy();
    expect(local_today).not.toBe(utc_today);

    await db.exec(`update clients set timezone = '${zone}' where id = '${AUCKLAND}'`);
    await db.exec(`
      insert into scheduled_posts (asset_id, scheduled_at)
      values ('${NZ_ASSET}', ((now() at time zone '${zone}')::date + time '12:00') at time zone '${zone}')`);

    const { state, scheduled_for } = await one<{ state: string; scheduled_for: string }>(
      `select state, scheduled_for::text as scheduled_for from distribution_due where client_id = '${AUCKLAND}'`,
    );
    // The post sits on the client's today. Against the server's date it would
    // read as overdue or upcoming, which is what the board used to show.
    expect(scheduled_for).toBe(local_today);
    expect(state).toBe("due_today");
    await db.exec(`update clients set timezone = 'Pacific/Auckland' where id = '${AUCKLAND}'`);
  });

  it("still carries the columns the board already read", async () => {
    const rows = await db.query(`select * from distribution_due limit 0`);
    const names = rows.fields.map((f) => f.name);
    for (const column of ["schedule_id", "scheduled_for", "state", "days_late", "human_approved", "channel"]) {
      expect(names).toContain(column);
    }
    // and the two this migration adds
    expect(names).toContain("scheduled_at");
    expect(names).toContain("due_now");
  });
});

describe("the two ways in", () => {
  beforeEach(async () => {
    await db.exec(`delete from scheduled_posts where asset_id = '${NZ_ASSET}'`);
  });

  it("schedule_asset puts the post at the local time it was given", async () => {
    await db.exec(`select schedule_asset('${NZ_ASSET}', date '${BST_DAY}', 'organic', null, time '18:45')`);
    const { local } = await one<{ local: string }>(`
      select to_char(scheduled_at at time zone 'Pacific/Auckland', 'YYYY-MM-DD HH24:MI') as local
      from scheduled_posts where asset_id = '${NZ_ASSET}'`);
    expect(local).toBe(`${BST_DAY} 18:45`);
  });

  it("schedule_asset without a time still lands on the default hour", async () => {
    await db.exec(`select schedule_asset('${NZ_ASSET}', date '${BST_DAY}')`);
    const { local } = await one<{ local: string }>(`
      select to_char(scheduled_at at time zone 'Pacific/Auckland', 'YYYY-MM-DD HH24:MI') as local
      from scheduled_posts where asset_id = '${NZ_ASSET}'`);
    expect(local).toBe(`${BST_DAY} 09:00`);
  });

  it("the gateway wrapper carries the time through to the row", async () => {
    // The wrapper is the only thing the gateway calls, so a time the
    // function underneath accepts is useless if the wrapper drops it.
    await db.exec(`
      select mcp_queue_distribution('bot_distribution', 'req-1', 'exec-1',
        '${AUCKLAND}', '${NZ_ASSET}', date '${BST_DAY}', 'organic', time '07:15')`);
    const { local } = await one<{ local: string }>(`
      select to_char(scheduled_at at time zone 'Pacific/Auckland', 'YYYY-MM-DD HH24:MI') as local
      from scheduled_posts where asset_id = '${NZ_ASSET}'`);
    expect(local).toBe(`${BST_DAY} 07:15`);
  });

  it("the gateway wrapper still works without one", async () => {
    await db.exec(`
      select mcp_queue_distribution('bot_distribution', 'req-2', 'exec-2',
        '${AUCKLAND}', '${NZ_ASSET}', date '${BST_DAY}', 'organic')`);
    const { local } = await one<{ local: string }>(`
      select to_char(scheduled_at at time zone 'Pacific/Auckland', 'YYYY-MM-DD HH24:MI') as local
      from scheduled_posts where asset_id = '${NZ_ASSET}'`);
    expect(local).toBe(`${BST_DAY} 09:00`);
  });
});

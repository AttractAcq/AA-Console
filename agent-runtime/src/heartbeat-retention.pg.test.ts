import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("prunes old heartbeats in bounded batches and preserves fresh liveness", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.agent_runtime_heartbeats (
        id integer primary key, worker_id text not null, reported_at timestamptz not null
      );
      create schema cron;
      create table cron.job (jobname text primary key, schedule text, command text);
      create function cron.unschedule(p_name text) returns boolean language plpgsql as $$
      begin delete from cron.job where jobname = p_name; return true; end $$;
      create function cron.schedule(p_name text, p_schedule text, p_command text)
      returns integer language plpgsql as $$
      begin insert into cron.job values (p_name, p_schedule, p_command); return 1; end $$;
      insert into public.agent_runtime_heartbeats
        select n, 'worker-1', now() - interval '8 days'
          from generate_series(1, 5002) n;
      insert into public.agent_runtime_heartbeats
        values (5003, 'worker-1', now() - interval '1 day');
      grant usage on schema public to anon, authenticated, service_role;
    `);
    const migration = await readFile(
      new URL("../../supabase/migrations/20261029130000_262_runtime_heartbeat_retention.sql", import.meta.url),
      "utf8",
    );
    await db.exec(migration);
    await db.exec(migration); // Reapplying must leave one scheduled job.

    const schedule = await db.query<{ count: number }>(
      "select count(*)::integer as count from cron.job where jobname = 'prune-runtime-heartbeats'",
    );
    expect(schedule.rows[0]?.count).toBe(1);

    await db.exec("set role anon");
    await expect(db.query("select public.prune_agent_runtime_heartbeats()"))
      .rejects.toThrow(/permission denied/);
    await db.exec("reset role; set role service_role");
    const first = await db.query<{ deleted: number }>(
      "select public.prune_agent_runtime_heartbeats() as deleted",
    );
    expect(first.rows[0]?.deleted).toBe(5000);
    const second = await db.query<{ deleted: number }>(
      "select public.prune_agent_runtime_heartbeats() as deleted",
    );
    expect(second.rows[0]?.deleted).toBe(2);
    const third = await db.query<{ deleted: number }>(
      "select public.prune_agent_runtime_heartbeats() as deleted",
    );
    expect(third.rows[0]?.deleted).toBe(0);
    await db.exec("reset role");
    const remaining = await db.query<{ id: number }>(
      "select id from public.agent_runtime_heartbeats",
    );
    expect(remaining.rows).toEqual([{ id: 5003 }]);
  } finally { await db.close(); }
});

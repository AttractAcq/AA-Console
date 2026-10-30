import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("migration 261 gives only service role safe schema and cron metadata", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema supabase_migrations;
      create table supabase_migrations.schema_migrations (version text primary key);
      insert into supabase_migrations.schema_migrations values ('20261025233000');
      create schema cron;
      create table cron.job (jobid integer, jobname text, schedule text, active boolean, command text);
      insert into cron.job values (1, 'engine-tick', '* * * * *', true, 'select private_password');
      insert into cron.job values (2, null, '*/5 * * * *', true, 'select other_secret');
      create table public.inventory_fixture (id integer);
      create table public.agent_runtime_heartbeats (
        id text primary key, worker_id text not null, status text not null,
        version text, queue_depth integer, active_jobs integer,
        metadata jsonb not null default '{}', reported_at timestamptz not null
      );
      insert into public.agent_runtime_heartbeats
        (id, worker_id, status, version, queue_depth, active_jobs, reported_at) values
        ('1', 'agent-runtime:1', 'healthy', 'older', 9, 1, now() - interval '5 minutes'),
        ('2', 'agent-runtime:1', 'healthy', 'latest', 0, 0, now()),
        ('3', 'agent-runtime:2', 'healthy', 'second', 1, 0, now());
      create view public.agent_runtime_status as
        select h.worker_id, h.status, h.version, h.queue_depth, h.active_jobs,
               h.metadata, h.reported_at, (now() - h.reported_at) as age,
               (h.reported_at > now() - interval '90 seconds') as is_live
        from public.agent_runtime_heartbeats h
        where h.reported_at = (select max(h2.reported_at)
          from public.agent_runtime_heartbeats h2 where h2.worker_id = h.worker_id);
      grant usage on schema public to anon, authenticated, service_role;
      grant select on public.agent_runtime_heartbeats, public.agent_runtime_status to service_role;
    `);
    const sql = await readFile(new URL("../../../supabase/migrations/20261029120000_261_system_readiness_inventory.sql", import.meta.url), "utf8");
    await db.exec(sql);
    await db.exec("set role anon");
    await expect(db.query("select public.system_readiness_catalog()")).rejects.toThrow(/permission denied/);
    await db.exec("reset role; set role service_role");
    const result = await db.query<{ inventory: Record<string, unknown> }>(
      "select public.system_readiness_catalog() as inventory");
    const inventory = result.rows[0]!.inventory;
    expect(inventory.migrationHead).toBe("20261025233000");
    expect(inventory.cronJobs).toEqual([
      { name: "engine-tick", schedule: "* * * * *", active: true },
      { name: "unnamed#2", schedule: "*/5 * * * *", active: true },
    ]);
    expect(JSON.stringify(inventory)).not.toContain("private_password");
    expect(JSON.stringify(inventory)).not.toContain("other_secret");
    expect((inventory.objects as { tables: number }).tables).toBeGreaterThan(0);
    const beats = await db.query<{ worker_id: string; version: string; is_live: boolean }>(
      "select worker_id, version, is_live from public.agent_runtime_status order by worker_id");
    expect(beats.rows).toEqual([
      { worker_id: "agent-runtime:1", version: "latest", is_live: true },
      { worker_id: "agent-runtime:2", version: "second", is_live: true },
    ]);
    const options = await db.query<{ reloptions: string[] }>(
      "select reloptions from pg_catalog.pg_class where relname = 'agent_runtime_status'");
    expect(options.rows[0]?.reloptions).toContain("security_invoker=on");
    await db.exec("reset role; set enable_seqscan = off");
    const plan = await db.query<{ "QUERY PLAN": string }>(
      "explain select worker_id, version from public.agent_runtime_status");
    expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n"))
      .toContain("agent_runtime_heartbeats_worker_latest_idx");
  } finally { await db.close(); }
});

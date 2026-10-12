import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const CAMPAIGN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("generated idea campaign positions", () => {
  it("positions explicit campaign ideas after the reserved batch and rejects mismatches", async () => {
    const db = new PGlite();
    try {
      await db.exec(`
        create table agent_jobs (id uuid primary key, agent_key text, client_id uuid, params jsonb);
        create table client_campaigns (id uuid primary key, client_id uuid, content_count integer,
          content_ideas_generated_at timestamptz, built_at timestamptz, archived_at timestamptz,
          status text not null default 'planning');
        create table workflow_runs (id uuid primary key, client_id uuid, campaign_id uuid, kind text);
        create table client_ideas (id uuid primary key, client_id uuid, job_id uuid,
          campaign_id uuid, campaign_position integer,
          constraint client_ideas_campaign_position_pair check (
            (campaign_id is null and campaign_position is null)
            or (campaign_id is not null and campaign_position is not null and campaign_position > 0)));
        create unique index client_ideas_campaign_position_uniq
          on client_ideas (campaign_id, campaign_position) where campaign_id is not null;
        create function lock_down_definer_functions() returns void language sql as $$ select $$;
      `);
      await db.exec(await readFile(new URL(
        "../../supabase/migrations/20261012190000_200_generated_idea_campaign_position.sql",
        import.meta.url,
      ), "utf8"));
      await db.exec(`create trigger assign_generated_idea_campaign_before_insert
        before insert on client_ideas for each row execute function assign_generated_idea_campaign()`);
      await db.exec(`
        insert into client_campaigns (id,client_id,content_count,built_at)
          values ('${CAMPAIGN}','${CLIENT}',4,now());
        insert into agent_jobs (id,agent_key,client_id,params)
          values ('${JOB}','ideation','${CLIENT}',
            '{"campaign_id":"${CAMPAIGN}"}');
        insert into client_ideas (id,client_id,job_id,campaign_id)
          values ('00000000-0000-4000-8000-000000000001','${CLIENT}','${JOB}','${CAMPAIGN}');
        insert into client_ideas (id,client_id,job_id)
          values ('00000000-0000-4000-8000-000000000002','${CLIENT}','${JOB}');
      `);
      const result = await db.query<{ campaign_id: string; campaign_position: number }>(`
        select campaign_id, campaign_position from client_ideas
        where job_id='${JOB}' order by campaign_position`);
      expect(result.rows).toEqual([
        { campaign_id: CAMPAIGN, campaign_position: 5 },
        { campaign_id: CAMPAIGN, campaign_position: 6 },
      ]);
      await expect(db.exec(`insert into client_ideas (id,client_id,job_id,campaign_id)
        values ('00000000-0000-4000-8000-000000000003','${CLIENT}','${JOB}','${OTHER}')`))
        .rejects.toThrow(/does not match its job/);
      await db.exec(`update client_campaigns set built_at=null where id='${CAMPAIGN}'`);
      await expect(db.exec(`insert into workflow_runs (id,client_id,campaign_id,kind)
        values ('00000000-0000-4000-8000-000000000004','${CLIENT}',
          '${CAMPAIGN}','daily_content_package')`))
        .rejects.toThrow(/needs a built, available campaign/);
    } finally {
      await db.close();
    }
  });
});

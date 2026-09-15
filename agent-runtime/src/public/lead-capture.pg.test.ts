import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * capture_sales_agent_lead against a real Postgres.
 *
 * This function has existed since migration 67 and has never once run: nothing
 * called it, so no sales agent conversation has ever become a lead. Wiring it
 * up without executing it would be shipping an untested path into the one
 * place a visitor's details land.
 */
let db: PGlite;
const migration = (file: string) =>
  readFile(new URL(`../../../supabase/migrations/${file}`, import.meta.url), "utf8");

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as
      $$ select current_setting('request.jwt.claim.role', true) $$;
    grant usage on schema public, auth to authenticated, service_role, anon;
  `);
  for (const file of [
    "20260903104450_01_foundations_roles_clients.sql",
    "20260903104529_02_team_and_operations.sql",
    "20260903104615_03_agent_registry_and_job_queue.sql",
    "20260903104816_05_content_chain_proof_ideas_briefs_media.sql",
    "20260903104850_06_distribution_conversion_leads.sql",
    "20260904080405_14_campaigns.sql",
  ]) await db.exec(await migration(file));

  // Columns later migrations add, which this partial fixture skips over.
  await db.exec(`
    alter table agents add column if not exists archived_at timestamptz;
    alter table agents add column if not exists requires_input boolean not null default false;
  `);

  // Migration 19 is where the client-read policies in 60/67 get this from. It
  // is defined inline, verbatim, rather than loading 19's full table sweep,
  // which touches tables this fixture does not create.
  await db.exec(`
    create or replace function is_client_user(target uuid)
    returns boolean language sql stable security definer set search_path = public as $$
      select exists (select 1 from client_users cu where cu.user_id = auth.uid() and cu.client_id = target);
    $$;
    revoke execute on function is_client_user(uuid) from anon, public;
    grant execute on function is_client_user(uuid) to authenticated;
  `);

  for (const file of [
    "20260908030000_60_revenue_pipeline.sql",
    "20260908192515_67_sales_agents.sql",
  ]) await db.exec(await migration(file));

  await db.exec(`
    insert into clients (id, name, initials)
    values ('11111111-1111-1111-1111-111111111111', 'Attract Acquisition', 'AA');
    insert into client_sales_agents (id, client_id, name, purpose)
    values ('44444444-4444-4444-4444-444444444444',
            '11111111-1111-1111-1111-111111111111',
            'Appointment Agent', 'Books consultations.');
  `);
});

async function conversation(over: Record<string, string | boolean | null> = {}) {
  const fields = {
    contact_name: "Sam Okafor",
    contact_email: "sam@example.com",
    contact_phone: null,
    outcome: "Wants a quote for full-arch.",
    qualified: false,
    ...over,
  };
  const res = await db.query<{ id: string }>(
    `insert into sales_agent_conversations
       (client_id, sales_agent_id, contact_name, contact_email, contact_phone, outcome, qualified, transcript)
     values ('11111111-1111-1111-1111-111111111111',
             '44444444-4444-4444-4444-444444444444', $1, $2, $3, $4, $5, '[]'::jsonb)
     returning id`,
    [fields.contact_name, fields.contact_email, fields.contact_phone, fields.outcome, fields.qualified],
  );
  return res.rows[0]!.id;
}

const capture = (id: string) =>
  db.query<{ capture_sales_agent_lead: string }>(
    `select capture_sales_agent_lead($1::uuid) as capture_sales_agent_lead`,
    [id],
  );

beforeEach(async () => {
  await db.exec(`set request.jwt.claim.role = 'service_role'`);
  await db.exec(`delete from client_leads; delete from sales_agent_conversations;`);
});

describe("turning a conversation into a lead", () => {
  it("creates a lead somebody can actually contact", async () => {
    const id = await conversation();
    const out = await capture(id);
    const leadId = out.rows[0]!.capture_sales_agent_lead;
    expect(leadId).toBeTruthy();

    const lead = await db.query<Record<string, unknown>>(
      `select name, email, phone, source, source_channel, source_sales_agent_id, stage, notes
         from client_leads where id = $1`,
      [leadId],
    );
    expect(lead.rows[0]).toMatchObject({
      name: "Sam Okafor",
      email: "sam@example.com",
      source: "sales_agent",
      source_channel: "sales_agent",
      notes: "Wants a quote for full-arch.",
    });
  });

  it("captures somebody who left only a phone number", async () => {
    const id = await conversation({ contact_email: null, contact_phone: "031 555 0100" });
    const out = await capture(id);
    const lead = await db.query<{ phone: string; email: string | null }>(
      `select phone, email from client_leads where id = $1`,
      [out.rows[0]!.capture_sales_agent_lead],
    );
    expect(lead.rows[0]?.phone).toBe("031 555 0100");
  });

  it("refuses a conversation with no way to reach anyone", async () => {
    // A pipeline padded with unreachable rows stops being a measure of anything.
    const id = await conversation({ contact_email: null, contact_phone: null });
    await expect(capture(id)).rejects.toThrow(/no way to contact anyone/i);
    const count = await db.query<{ n: number }>(`select count(*)::int as n from client_leads`);
    expect(count.rows[0]?.n).toBe(0);
  });

  it("does not treat whitespace as contact details", async () => {
    const id = await conversation({ contact_email: "   ", contact_phone: "  " });
    await expect(capture(id)).rejects.toThrow(/no way to contact anyone/i);
  });

  it("starts an unqualified conversation at 'conversation', never at 'lead'", async () => {
    // A conversation happened by definition; claiming more than that would
    // inflate every funnel measured off this stage.
    const id = await conversation({ qualified: false });
    const out = await capture(id);
    const lead = await db.query<{ stage: string }>(
      `select stage::text as stage from client_leads where id = $1`,
      [out.rows[0]!.capture_sales_agent_lead],
    );
    expect(lead.rows[0]?.stage).toBe("conversation");
  });

  it("lifts a qualified conversation exactly one stage", async () => {
    const id = await conversation({ qualified: true });
    const out = await capture(id);
    const lead = await db.query<{ stage: string }>(
      `select stage::text as stage from client_leads where id = $1`,
      [out.rows[0]!.capture_sales_agent_lead],
    );
    expect(lead.rows[0]?.stage).toBe("qualified_conversation");
  });
});

describe("capturing the same conversation twice", () => {
  it("returns the lead that exists rather than duplicating a person", async () => {
    // The runtime calls this on every message once details are captured, so
    // this is the common path, not an edge case.
    const id = await conversation();
    const first = await capture(id);
    const second = await capture(id);
    expect(second.rows[0]?.capture_sales_agent_lead).toBe(first.rows[0]?.capture_sales_agent_lead);

    const count = await db.query<{ n: number }>(`select count(*)::int as n from client_leads`);
    expect(count.rows[0]?.n).toBe(1);
  });

  it("records the capture against the conversation, so it is traceable", async () => {
    const id = await conversation();
    const out = await capture(id);
    const conv = await db.query<{ lead_id: string }>(
      `select lead_id from sales_agent_conversations where id = $1`,
      [id],
    );
    expect(conv.rows[0]?.lead_id).toBe(out.rows[0]?.capture_sales_agent_lead);
  });
});

describe("who may capture a lead", () => {
  it("refuses a caller with no access to the client", async () => {
    const id = await conversation();
    await db.exec(`set request.jwt.claim.role = 'authenticated'`);
    await db.exec(`set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222'`);
    await expect(capture(id)).rejects.toThrow(/not permitted/i);
    await db.exec(`set request.jwt.claim.role = 'service_role'`);
  });

  it("refuses a conversation that no longer exists", async () => {
    await expect(capture("33333333-3333-3333-3333-333333333333")).rejects.toThrow(/no longer exists/i);
  });
});

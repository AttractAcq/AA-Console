import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Migration 235 against a real Postgres.
 *
 * This is the first path in the system by which somebody who is not signed
 * in can create a row, so almost everything worth asserting is a refusal:
 *
 *   - a token that is wrong, off, expired, revoked or over quota
 *   - a submission with no consent
 *   - a submission nobody could reply to
 *   - the same form posted twice
 *   - one client's endpoint attributing leads to another client's campaign
 *   - anyone but the internal service calling the capture function
 *
 * And two things that must happen rather than not: the consent wording is
 * stored as the words the person saw, and a returning person becomes one
 * lead with two touches.
 */
let db: PGlite;

const CLIENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const MANAGER = "55555555-5555-4555-8555-555555555555";
const CAMPAIGN = "66666666-6666-4666-8666-666666666666";
const OTHER_CAMPAIGN = "77777777-7777-4777-8777-777777777777";
const PAGE = "88888888-8888-4888-8888-888888888888";

const TOKEN = "a".repeat(64);
const WORDING = "I agree to Harbour Home contacting me about my enquiry.";

const sql = (file: string) =>
  readFile(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8");

async function rows<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(q, p)).rows;
}
async function one<T = Record<string, unknown>>(q: string, p: unknown[] = []): Promise<T> {
  return (await rows<T>(q, p))[0]!;
}

const asService = () => db.exec("set test.role = 'service_role'");
const asHuman = () => db.exec("set test.role = 'authenticated'");

/** An endpoint a stranger could post to, unless a test switches something off. */
async function endpoint(over: { token?: string; campaign?: string | null; purpose?: string } = {}) {
  const row = await one<{ id: string }>(
    `select id from create_lead_capture_endpoint_v6($1,$2,$3,$4,$5,$6,'paid_social',90,500)`,
    [
      CLIENT,
      over.purpose ?? "magnet_optin",
      over.token ?? TOKEN,
      WORDING,
      "campaign" in over ? over.campaign : CAMPAIGN,
      PAGE,
    ],
  );
  await db.query("select set_lead_capture_enabled_v6($1,true)", [row.id]);
  return row.id;
}

/** Post to it the way the runtime's public route will. */
async function submit(over: Record<string, unknown> = {}) {
  await asService();
  const result = await one<{ capture_lead_v6: Record<string, unknown> }>(
    `select capture_lead_v6($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      over.token ?? TOKEN,
      over.key ?? "sub-1",
      over.name ?? "Jay Okafor",
      "email" in over ? over.email : "JAY@example.test",
      "phone" in over ? over.phone : null,
      over.message ?? "Garage is damp",
      over.consented ?? true,
      JSON.stringify(over.evidence ?? { ip_hash: "deadbeef" }),
      over.clickId ?? "gclid-123",
      JSON.stringify(over.utm ?? { utm_source: "google" }),
    ],
  );
  await asHuman();
  return result.capture_lead_v6;
}

async function blocker(id: string): Promise<string | null> {
  const row = await one<{ blocker: string | null }>(
    "select blocker from lead_capture_due where endpoint_id = $1",
    [id],
  );
  return row?.blocker ?? null;
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
 create role authenticated; create role anon; create role service_role;
 create schema auth;
 create function auth.role() returns text language sql as $$select coalesce(current_setting('test.role',true),'authenticated')$$;
 create function auth.uid() returns uuid language sql as $$select '${MANAGER}'::uuid$$;
 create function is_admin() returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'true')='true'$$;
 create function active_video_approval_manager(uuid) returns uuid language sql as $$select '${MANAGER}'::uuid$$;
 create function can_access_client(uuid) returns boolean language sql as $$select $1='${CLIENT}'::uuid$$;
 create function lock_down_definer_functions() returns integer language sql as $$select 0$$;
 create function set_updated_at() returns trigger language plpgsql as $$begin new.updated_at := now(); return new; end$$;

 create type lead_stage as enum ('lead','conversation','qualified_conversation','appointment',
   'qualified_appointment','shown','sale','cash','lost');
 create type pipeline_stage as enum ('first_touch','engaged','booked');

 create table clients(id uuid primary key);
 create table profiles(id uuid primary key);
 create table campaigns(id uuid primary key);
 create table client_campaigns(id uuid primary key, client_id uuid, unique (id, client_id));
 create table client_pages(id uuid primary key, client_id uuid);
 create table client_media_assets(id uuid primary key);
 create table scheduled_posts(id uuid primary key);
 create table team_members(id uuid primary key);
 create table client_sales_agents(id uuid primary key);

 -- client_leads as migrations 06, 60 and 67 leave it.
 create table client_leads(
   id uuid primary key default gen_random_uuid(),
   client_id uuid not null references clients(id) on delete cascade,
   name text, contact text, source text, notes text,
   pipeline_stage pipeline_stage not null default 'first_touch',
   email text, phone text,
   stage lead_stage not null default 'lead',
   stage_at timestamptz not null default now(),
   lost_reason text,
   owner_member_id uuid references team_members(id) on delete set null,
   next_action text, next_action_due date,
   opportunity_value numeric(12,2), sale_value numeric(12,2), cash_collected numeric(12,2),
   appointment_at timestamptz, appointment_outcome text,
   source_channel text,
   source_page_id uuid references client_pages(id) on delete set null,
   source_asset_id uuid references client_media_assets(id) on delete set null,
   source_post_id uuid references scheduled_posts(id) on delete set null,
   source_campaign_id uuid references campaigns(id) on delete set null,
   source_sales_agent_id uuid references client_sales_agents(id) on delete set null,
   created_by uuid references profiles(id) on delete set null,
   created_at timestamptz not null default now(),
   updated_at timestamptz not null default now());

 create table lead_events(
   id uuid primary key default gen_random_uuid(),
   lead_id uuid not null references client_leads(id) on delete cascade,
   client_id uuid not null references clients(id) on delete cascade,
   kind text not null check (kind in ('note','conversation','stage_change','appointment','outcome')),
   body text, from_stage lead_stage, to_stage lead_stage,
   occurred_at timestamptz not null default now(),
   created_by uuid references profiles(id) on delete set null,
   created_at timestamptz not null default now());

 insert into clients values('${CLIENT}'),('${OTHER}');
 insert into profiles values('${MANAGER}');
 insert into client_campaigns values('${CAMPAIGN}','${CLIENT}'),('${OTHER_CAMPAIGN}','${OTHER}');
 insert into client_pages values('${PAGE}','${CLIENT}');`);

  await db.exec(await sql("20261024090000_235_a_lead_can_arrive_from_outside.sql"));
  await asHuman();
}, 60000);

afterAll(async () => {
  await db?.close();
});

describe("opening an endpoint", () => {
  it("ships disabled, expiring and capped", async () => {
    const id = await one<{ id: string; enabled: boolean; max_submissions: number }>(
      `select id, enabled, max_submissions from create_lead_capture_endpoint_v6(
         $1,'page_form',$2,$3)`,
      [CLIENT, "b".repeat(64), WORDING],
    );
    expect(id.enabled).toBe(false);
    expect(id.max_submissions).toBe(500);
    expect(await blocker(id.id)).toBe("Switched off. Nothing posted here is accepted.");
  });

  it("refuses a campaign or page belonging to someone else", async () => {
    await expect(
      db.query(`select create_lead_capture_endpoint_v6($1,'page_form',$2,$3,$4)`, [
        CLIENT,
        "c".repeat(64),
        WORDING,
        OTHER_CAMPAIGN,
      ]),
    ).rejects.toThrow("does not belong to this client");
  });

  it("refuses anyone who is neither an admin nor the assigned manager", async () => {
    await db.exec("set test.admin = 'false'");
    await db.exec("drop function active_video_approval_manager(uuid) cascade");
    await db.exec(`create function active_video_approval_manager(uuid) returns uuid
      language sql as $$select null::uuid$$`);
    await expect(
      db.query(`select create_lead_capture_endpoint_v6($1,'page_form',$2,$3)`, [
        CLIENT,
        "d".repeat(64),
        WORDING,
      ]),
    ).rejects.toThrow("admin or the assigned client manager");
  });

  it("keeps only the hash of the token", async () => {
    const id = await endpoint();
    const row = await one<{ token_hash: string }>(
      "select token_hash from lead_capture_endpoints where id = $1",
      [id],
    );
    // A leaked table is not a set of live endpoints.
    expect(row.token_hash).toBe(TOKEN);
    expect(
      await rows("select 1 from information_schema.columns where table_name = 'lead_capture_endpoints' and column_name = 'token'"),
    ).toHaveLength(0);
  });
});

describe("what is refused at the door", () => {
  it("tells a stranger nothing about why", async () => {
    await endpoint();
    // An unknown token and a switched-off endpoint give the same sentence.
    expect(await submit({ token: "9".repeat(64) })).toMatchObject({
      ok: false,
      reason: "This form is not accepting submissions.",
    });
  });

  it("refuses a disabled, expired, revoked or exhausted endpoint alike", async () => {
    const id = await endpoint();
    await db.query("select set_lead_capture_enabled_v6($1,false)", [id]);
    expect(await submit({ key: "k1" })).toMatchObject({ ok: false });

    await db.query("select set_lead_capture_enabled_v6($1,true)", [id]);
    await db.exec("update lead_capture_endpoints set expires_at = now() - interval '1 day'");
    expect(await submit({ key: "k2" })).toMatchObject({ ok: false });
    expect(await blocker(id)).toContain("Expired on");

    await db.exec("update lead_capture_endpoints set expires_at = now() + interval '1 day', revoked_at = now()");
    expect(await submit({ key: "k3" })).toMatchObject({ ok: false });
    expect(await blocker(id)).toContain("Revoked on");

    await db.exec("update lead_capture_endpoints set revoked_at = null, submissions = 500");
    expect(await submit({ key: "k4" })).toMatchObject({
      ok: false,
      reason: "This form has reached its limit.",
    });
    expect(await blocker(id)).toContain("limit of 500");

    expect(await rows("select 1 from client_leads")).toHaveLength(0);
  });

  it("refuses a submission with no consent, and one nobody could answer", async () => {
    await endpoint();
    expect(await submit({ consented: false })).toMatchObject({
      ok: false,
      reason: "Consent is required.",
    });
    expect(await submit({ email: null, phone: null })).toMatchObject({
      ok: false,
      reason: "An email address or a phone number is required.",
    });
    expect(await rows("select 1 from lead_submissions")).toHaveLength(0);
  });

  it("is the internal service's to call", async () => {
    await endpoint();
    await expect(
      db.query(`select capture_lead_v6($1,'k','n','e@x.test',null,null,true)`, [TOKEN]),
    ).rejects.toThrow("Only the internal service");
  });
});

describe("a stranger becoming a lead", () => {
  it("records the words they agreed to, not that they agreed", async () => {
    await endpoint();
    const result = await submit();
    expect(result).toMatchObject({ ok: true, created: true, repeat: false });

    const lead = await one<{
      consent_wording: string;
      consent_given_at: string;
      consent_evidence: Record<string, unknown>;
      source_client_campaign_id: string;
      source_page_id: string;
      source_click_id: string;
      source_channel: string;
      email: string;
    }>("select * from client_leads");

    expect(lead.consent_wording).toBe(WORDING);
    expect(lead.consent_given_at).toBeTruthy();
    expect(lead.consent_evidence).toMatchObject({ ip_hash: "deadbeef" });
    // Attributed to the operational campaign and the page, with the click id
    // that is the only durable link back to the ad.
    expect(lead.source_client_campaign_id).toBe(CAMPAIGN);
    expect(lead.source_page_id).toBe(PAGE);
    expect(lead.source_click_id).toBe("gclid-123");
    expect(lead.source_channel).toBe("paid_social");
  });

  it("snapshots the wording, so changing the endpoint cannot rewrite history", async () => {
    await endpoint();
    await submit();
    await db.exec(`update lead_capture_endpoints set consent_wording = 'Totally different words now.'`);
    expect(
      await one<{ consent_wording: string }>("select consent_wording from client_leads"),
    ).toMatchObject({ consent_wording: WORDING });
    expect(
      await one<{ consent_wording: string }>("select consent_wording from lead_submissions"),
    ).toMatchObject({ consent_wording: WORDING });
  });

  it("writes the consent columns together or not at all", async () => {
    await expect(
      db.query(
        `insert into client_leads (client_id, email, consent_given_at) values ($1,'x@y.test', now())`,
        [CLIENT],
      ),
    ).rejects.toThrow("client_leads_consent_is_whole");
  });

  it("logs the arrival on the lead's own history", async () => {
    await endpoint();
    await submit();
    const event = await one<{ kind: string; body: string }>("select kind, body from lead_events");
    expect(event.kind).toBe("note");
    expect(event.body).toContain("Captured from magnet optin");
    expect(event.body).toContain("Consent recorded");
  });
});

describe("the same person twice", () => {
  it("treats a repeated submission reference as one submission", async () => {
    await endpoint();
    const first = await submit({ key: "same" });
    const second = await submit({ key: "same" });
    expect(second).toMatchObject({ lead_id: first.lead_id, created: false, repeat: true });
    expect(await rows("select 1 from lead_submissions")).toHaveLength(1);
    expect(await rows("select 1 from client_leads")).toHaveLength(1);
  });

  it("makes a returning person one lead with two touches", async () => {
    await endpoint();
    const first = await submit({ key: "one", email: "jay@example.test" });
    // Different case, different form, same person.
    const second = await submit({ key: "two", email: "JAY@EXAMPLE.TEST" });

    expect(second).toMatchObject({ lead_id: first.lead_id, created: false });
    expect(await rows("select 1 from client_leads")).toHaveLength(1);
    // Both submissions survive the merge: a deduplicated enquiry still
    // happened, and "did this person ever contact us" has to stay answerable.
    const subs = await rows<{ status: string; lead_id: string }>(
      "select status, lead_id from lead_submissions order by created_at",
    );
    expect(subs).toHaveLength(2);
    expect(subs.every((s) => s.status === "promoted" && s.lead_id === first.lead_id)).toBe(true);
    expect(await rows("select 1 from lead_events")).toHaveLength(2);
  });

  it("dedupes on the phone when there is no email, however it was written", async () => {
    await endpoint();
    const first = await submit({ key: "p1", email: null, phone: "07700 900123" });
    // The country code and the trunk zero are exactly what varies between
    // the ways one person writes their own number.
    const second = await submit({ key: "p2", email: null, phone: "+44 7700 900123" });
    expect(second).toMatchObject({ lead_id: first.lead_id, created: false });
  });

  it("does not merge two people who merely look similar", async () => {
    await endpoint();
    const first = await submit({ key: "d1", email: null, phone: "07700 900123" });
    const other = await submit({ key: "d2", email: null, phone: "07700 900124" });
    expect(other.lead_id).not.toBe(first.lead_id);
    // Merging two strangers is worse than missing a merge, which is the
    // whole reason the phone rule keeps nine digits rather than seven.
    expect(await rows("select 1 from client_leads")).toHaveLength(2);

    const differentAddress = await submit({ key: "d3", email: "jay.okafor@example.test" });
    expect(differentAddress.created).toBe(true);
  });
});

describe("what an operator sees", () => {
  it("says a live endpoint is live, and counts what came through it", async () => {
    const id = await endpoint();
    await submit({ key: "s1" });
    await submit({ key: "s2", email: "other@example.test" });

    const due = await one<{
      blocker: string | null;
      received: number;
      became_leads: number;
      submissions: number;
    }>("select * from lead_capture_due where endpoint_id = $1", [id]);
    expect(due.blocker).toBeNull();
    expect(Number(due.received)).toBe(2);
    expect(Number(due.became_leads)).toBe(2);
    expect(Number(due.submissions)).toBe(2);
  });

  it("ends with the grant sweep", async () => {
    expect(await sql("20261024090000_235_a_lead_can_arrive_from_outside.sql")).toContain(
      "select lock_down_definer_functions();",
    );
  });
});

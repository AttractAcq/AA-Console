// Cross-client RLS isolation test.
//
// Signs in as two real client accounts and tries to reach each other's data
// every way the API allows: unfiltered reads, reads filtered explicitly to
// the other client's id, the clients table itself, child rows that carry no
// client_id of their own, cross-client UPDATE / INSERT / DELETE, and the
// permission function underneath it all.
//
// This exists because the guarantee it checks is the one whose failure is
// silent. Nothing in the app surfaces a leak; only a test like this does.
//
// Run:
//   set -a && . ./.env.local && set +a \
//     && RLS_TEST_CLIENT_A_PASSWORD=... RLS_TEST_CLIENT_B_PASSWORD=... \
//        node scripts/rls-isolation-test.mjs
//
// It only reads, plus three write attempts that are expected to be refused.
// If any of those ever succeed, the script reports it and the data really has
// been changed - check the rows it names.

const URL = process.env.VITE_SUPABASE_URL;
const KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Credentials come from the environment, never from this file — a test that
// checks who can read what should not itself be a place passwords live.
const AA = {
  name: "Attract Acquisition",
  id: "e4b4b001-81f6-4997-8429-ff21f4ee1fbe",
  email: "attractacquisition@attractacq.com",
  pw: process.env.RLS_TEST_CLIENT_A_PASSWORD,
};
const HD = {
  name: "Harbour Dental",
  id: "d4c87828-741b-44eb-bbeb-16eac3471710",
  email: "harbourdental@attractacq.com",
  pw: process.env.RLS_TEST_CLIENT_B_PASSWORD,
};

for (const u of [AA, HD]) {
  if (!u.pw) {
    console.error(
      `Missing password for ${u.email}. Set RLS_TEST_CLIENT_A_PASSWORD and ` +
        "RLS_TEST_CLIENT_B_PASSWORD in your environment before running.",
    );
    process.exit(1);
  }
}

const TABLES = [
  "agent_jobs","agent_tool_calls","campaigns","client_agent_inputs","client_agent_records",
  "client_assignments","client_audit_notes","client_billing","client_briefs","client_business_context",
  "client_contracts","client_ideas","client_integrations","client_leads","client_media_assets",
  "client_onboarding_steps","client_pages","client_proof_assets","client_users","finance_entries",
  "job_assignments","master_ai_conversations","metrics_daily","ref_counters","scheduled_posts","work_logs",
];

async function login(u) {
  const r = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: u.email, password: u.pw }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`login failed for ${u.email}: ${JSON.stringify(j)}`);
  return j.access_token;
}

const get = (token, path) =>
  fetch(`${URL}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });

let failures = [];
const fail = (m) => { failures.push(m); console.log("  *** LEAK: " + m); };

async function run() {
  const tokens = { [AA.name]: await login(AA), [HD.name]: await login(HD) };
  console.log("Both client accounts signed in.\n");

  for (const [self, other] of [[AA, HD], [HD, AA]]) {
    const token = tokens[self.name];
    console.log(`=== Signed in as ${self.name} — attempting to reach ${other.name} ===`);

    // 1. Unfiltered reads: does anything from the other client come back?
    for (const t of TABLES) {
      const r = await get(token, `${t}?select=client_id`);
      if (!r.ok) continue; // 403/404 is a pass, not a leak
      const rows = await r.json();
      if (!Array.isArray(rows)) continue;
      const foreign = rows.filter((x) => x.client_id && x.client_id !== self.id);
      if (foreign.length) fail(`${t}: unfiltered read returned ${foreign.length} row(s) belonging to another client`);
    }
    console.log(`  unfiltered reads across ${TABLES.length} tables: ${failures.length ? "SEE ABOVE" : "no foreign rows"}`);

    // 2. Targeted reads: explicitly ask for the other client's rows.
    let targeted = 0;
    for (const t of TABLES) {
      const r = await get(token, `${t}?select=*&client_id=eq.${other.id}`);
      if (!r.ok) continue;
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length) { fail(`${t}: targeted read for ${other.name} returned ${rows.length} row(s)`); targeted += rows.length; }
    }
    console.log(`  targeted reads for the other client's id: ${targeted} row(s) returned`);

    // 3. The clients table itself.
    const cr = await get(token, `clients?select=id,name`);
    const clients = cr.ok ? await cr.json() : [];
    const foreignClients = clients.filter((c) => c.id !== self.id);
    if (foreignClients.length) fail(`clients: sees ${foreignClients.map((c) => c.name).join(", ")}`);
    console.log(`  clients table: sees ${clients.length} (${clients.map((c) => c.name).join(", ") || "none"})`);

    // 4. Child rows reached through a parent, which have no client_id of their own.
    const ev = await get(token, `agent_job_events?select=job_id&limit=200`);
    if (ev.ok) {
      const rows = await ev.json();
      if (Array.isArray(rows) && rows.length) {
        // Every job for the other client is off limits; any event at all is
        // suspicious for AA, which has no jobs.
        console.log(`  agent_job_events visible: ${rows.length}`);
        if (self.id === AA.id && rows.length > 0) fail(`agent_job_events: ${rows.length} row(s) visible but this client has no jobs`);
      } else console.log("  agent_job_events visible: 0");
    }

    // 5. Writes: try to modify and to insert against the other client.
    const upd = await fetch(`${URL}/rest/v1/client_business_context?client_id=eq.${other.id}`, {
      method: "PATCH",
      headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ business_overview: "OVERWRITTEN BY ANOTHER CLIENT" }),
    });
    const updBody = await upd.json().catch(() => []);
    if (upd.ok && Array.isArray(updBody) && updBody.length) fail(`client_business_context: UPDATE against ${other.name} changed ${updBody.length} row(s)`);
    else console.log(`  cross-client UPDATE: refused (${upd.status})`);

    const ins = await fetch(`${URL}/rest/v1/client_audit_notes`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ client_id: other.id, note: "planted by another client", noted_on: "2026-09-05" }),
    });
    const insBody = await ins.json().catch(() => ({}));
    if (ins.ok && Array.isArray(insBody) && insBody.length) fail(`client_audit_notes: INSERT for ${other.name} succeeded`);
    else console.log(`  cross-client INSERT: refused (${ins.status})`);

    const del = await fetch(`${URL}/rest/v1/campaigns?client_id=eq.${other.id}`, {
      method: "DELETE",
      headers: { apikey: KEY, Authorization: `Bearer ${token}`, Prefer: "return=representation" },
    });
    const delBody = await del.json().catch(() => []);
    if (del.ok && Array.isArray(delBody) && delBody.length) fail(`campaigns: DELETE against ${other.name} removed ${delBody.length} row(s)`);
    else console.log(`  cross-client DELETE: refused (${del.status})`);

    // 6. The permission function itself.
    const rpc = await fetch(`${URL}/rest/v1/rpc/can_access_client`, {
      method: "POST",
      headers: { apikey: KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ target: other.id }),
    });
    const allowed = await rpc.json().catch(() => null);
    if (allowed === true) fail(`can_access_client(${other.name}) returned true`);
    else console.log(`  can_access_client(other) = ${JSON.stringify(allowed)}`);

    // 7. Admin-only surfaces.
    for (const t of ["profiles", "team_members", "finance_periods", "agents"]) {
      const r = await get(token, `${t}?select=id&limit=5`);
      const rows = r.ok ? await r.json() : [];
      console.log(`  ${t}: ${Array.isArray(rows) ? rows.length : 0} row(s) visible`);
    }
    console.log();
  }

  console.log("=".repeat(60));
  console.log(failures.length === 0 ? "RESULT: no cross-client leak found." : `RESULT: ${failures.length} LEAK(S)`);
  failures.forEach((f) => console.log("  - " + f));
}
run().catch((e) => { console.error("test error:", e.message); process.exit(1); });

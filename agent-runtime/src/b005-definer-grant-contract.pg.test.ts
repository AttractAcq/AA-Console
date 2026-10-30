import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const contract = await readFile(new URL(
  "../../supabase/verification/b005-definer-grant-contract.sql",
  import.meta.url,
), "utf8");
let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema mcp_internal;
    create function public.may_manage_client_leads(uuid) returns boolean
      language sql security definer as $$select true$$;
    create function public.enqueue_sequence_sweep() returns uuid
      language sql security definer as $$select null::uuid$$;
    create function public.can_read_client_sales_data(uuid) returns boolean
      language sql security definer as $$select true$$;
    create function public.can_read_workflow_lead_attribution(uuid) returns boolean
      language sql security definer as $$select true$$;
    revoke execute on all functions in schema public
      from public, anon, authenticated, service_role;
    grant execute on function public.may_manage_client_leads(uuid),
      public.enqueue_sequence_sweep() to service_role;
    grant execute on function public.can_read_client_sales_data(uuid),
      public.can_read_workflow_lead_attribution(uuid)
      to authenticated, service_role;
  `);
});

afterEach(async () => { await db?.close(); });

describe("B005 replay definer grant contract", () => {
  it("accepts the narrow role matrix and leaves invoker utilities alone", async () => {
    await db.exec(`create function public.visible_utility() returns boolean
      language sql security invoker as $$select true$$;`);
    await expect(db.exec(contract)).resolves.toBeDefined();
  });

  it("catches an anonymous definer even in a non-public callable schema", async () => {
    await db.exec(`create function mcp_internal.rogue() returns boolean
      language sql security definer as $$select true$$;
      grant usage on schema mcp_internal to anon;`);
    await expect(db.exec(contract)).rejects.toThrow(/Anonymous SECURITY DEFINER execution/);
  });

  it("catches an internal sales helper exposed to authenticated callers", async () => {
    await db.exec(`grant execute on function public.may_manage_client_leads(uuid)
      to authenticated;`);
    await expect(db.exec(contract)).rejects.toThrow(/internal sales function grants drifted/);
  });

  it("catches a scoped policy predicate whose signed-in grant disappears", async () => {
    await db.exec(`revoke execute on function public.can_read_client_sales_data(uuid)
      from authenticated;`);
    await expect(db.exec(contract)).rejects.toThrow(/scoped sales predicate grants drifted/);
  });
});

import { describe, expect, it } from "vitest";
import {
  isMissingFunction,
  isMissingSchemaObject,
  isMissingTable,
  MIGRATION_PENDING_NOTE,
} from "./schemaGaps";

describe("telling a missing schema object from a real failure", () => {
  it("recognises a table PostgREST has no cache entry for", () => {
    expect(isMissingTable({
      code: "PGRST205",
      message: "Could not find the table 'public.archived_leads' in the schema cache",
    })).toBe(true);
  });

  it("recognises a table Postgres itself rejects", () => {
    expect(isMissingTable({
      code: "42P01",
      message: 'relation "public.recruitment_meta_campaigns" does not exist',
    })).toBe(true);
  });

  it("recognises a missing RPC from either layer", () => {
    expect(isMissingFunction({
      code: "PGRST202",
      message: "Could not find the function public.request_recruitment_meta_build(p_campaign_id)",
    })).toBe(true);
    expect(isMissingFunction({ code: "42883", message: "function foo(uuid) does not exist" })).toBe(true);
  });

  it("falls back to the wording when the code is absent or unfamiliar", () => {
    // Which layer answers has changed between supabase-js releases, so the
    // guard must not go quiet just because the code did.
    expect(isMissingTable({ message: "Could not find the table 'public.archived_leads'" })).toBe(true);
    expect(isMissingFunction({ code: "404", message: "Could not find the function public.foo" })).toBe(true);
  });

  it("does not mistake a permission denial for a missing object", () => {
    const denied = { code: "42501", message: 'permission denied for table archived_leads' };
    expect(isMissingTable(denied)).toBe(false);
    expect(isMissingSchemaObject(denied)).toBe(false);
  });

  it("does not mistake RLS returning nothing, a timeout or a null error", () => {
    expect(isMissingSchemaObject({ code: "57014", message: "canceling statement due to statement timeout" })).toBe(false);
    expect(isMissingSchemaObject({ code: "23503", message: "violates foreign key constraint" })).toBe(false);
    expect(isMissingSchemaObject(null)).toBe(false);
    expect(isMissingSchemaObject(undefined)).toBe(false);
    expect(isMissingSchemaObject({})).toBe(false);
  });

  it("keeps the two kinds apart", () => {
    const table = { code: "PGRST205", message: "Could not find the table 'public.x' in the schema cache" };
    const fn = { code: "PGRST202", message: "Could not find the function public.y" };
    expect(isMissingTable(table)).toBe(true);
    expect(isMissingFunction(table)).toBe(false);
    expect(isMissingFunction(fn)).toBe(true);
    expect(isMissingTable(fn)).toBe(false);
  });

  it("offers a note that names the cause rather than apologising", () => {
    expect(MIGRATION_PENDING_NOTE).toMatch(/migration/i);
  });
});

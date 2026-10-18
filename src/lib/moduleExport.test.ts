import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { from } }));

import { downloadModuleZip, loadExportDocument, renderExportPdf } from "./moduleExport";

type Response = { data: unknown; error: { message: string } | null };
const rows: Record<string, Response> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(rows)) delete rows[key];
  from.mockImplementation((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order"]) chain[method] = () => chain;
    chain.maybeSingle = () => Promise.resolve(rows[table] ?? { data: null, error: null });
    chain.then = (resolve: (value: Response) => unknown) =>
      Promise.resolve(rows[table] ?? { data: [], error: null }).then(resolve);
    return chain;
  });
});

describe("module PDF export", () => {
  it("includes all saved business fields in a real PDF", async () => {
    rows.clients = { data: { name: "Acme" }, error: null };
    rows.client_business_context = {
      data: { business_overview: "A detailed business overview", brand_voice: "Plain spoken" },
      error: null,
    };
    const doc = await loadExportDocument("client-1", { id: "business-context", label: "Business Context" });
    expect(doc.sections.find((section) => section.title === "Brand Voice")?.body).toBe("Plain spoken");
    const pdf = await renderExportPdf(doc, "Acme", "intelligence");
    expect(new TextDecoder().decode(pdf.slice(0, 8))).toMatch(/^%PDF-/);
    expect(pdf.byteLength).toBeGreaterThan(1000);
  });

  it("exports only the latest campaign period and includes records without templates", async () => {
    rows.record_templates = { data: [{ item_key: "plan", title: "Plan", description: null, display_order: 0 }], error: null };
    rows.client_agent_records = {
      data: [
        { item_key: "plan", title: "Plan", body: "Old plan", period: "2025", display_order: 0 },
        { item_key: "plan", title: "Plan", body: "Current plan", period: "2026", display_order: 0 },
        { item_key: "reference", title: "Research", body: "Reference note", period: null, display_order: 1 },
      ],
      error: null,
    };
    const doc = await loadExportDocument("client-1", { id: "campaign-intelligence", label: "Campaign Intelligence" });
    expect(doc.subtitle).toBe("Period 2026");
    expect(doc.sections.map((section) => section.body)).toEqual(["Current plan", "Reference note"]);
  });

  it("puts one PDF for every tab in the ZIP", async () => {
    rows.clients = { data: { name: "Acme & Co" }, error: null };
    rows.client_business_context = { data: { business_overview: "Hello" }, error: null };
    rows.client_content_pillars = { data: [{ name: "Education", premise: "Teach", belongs: "Guides", does_not_belong: "Ads", target_share: 50, active: true }], error: null };
    let blob: Blob | undefined;
    const createUrl = vi.spyOn(URL, "createObjectURL").mockImplementation((value) => {
      blob = value as Blob;
      return "blob:test";
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await downloadModuleZip("client-1", "strategy", [
      { id: "business-context", label: "Business Context" },
      { id: "content-pillars", label: "Content Pillars" },
    ]);
    expect(document.querySelector("a[download]")).toBeNull();
    expect(click).toHaveBeenCalledOnce();
    expect(blob).toBeDefined();
    const zip = await JSZip.loadAsync(await blob!.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual([
      "acme-co-business-context.pdf",
      "acme-co-content-pillars.pdf",
    ]);
    for (const file of Object.values(zip.files)) {
      expect(await file.async("string")).toMatch(/^%PDF-/);
    }
    createUrl.mockRestore();
    click.mockRestore();
  });
});

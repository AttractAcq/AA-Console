import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FormModal } from "./FormModal";
import {
  integrationDraftKey, purgeLegacySensitiveDrafts, readDraft, syncDraftIdentity,
  teamMemberDraftKey, writeDraft,
} from "./draftStorage";
import type { FieldDef } from "./fields";

const marker = "opaque-private-marker";
const currentKey = (key: string) => `aa-console:draft:v3:user-1:${key}`;
const oldKey = (key: string) => `aa-console:draft:${key}`;
const envelope = (values: Record<string, unknown>, savedAt = Date.now()) => JSON.stringify({ savedAt, values });

const teamFields: FieldDef[] = [
  { name: "name", label: "Name", kind: "text" },
  { name: "engagement", label: "Engagement", kind: "select", options: [{ value: "contractor", label: "Contractor" }] },
  { name: "username", label: "Username", kind: "text" },
  { name: "password", label: "Password", kind: "password" },
];
const integrationFields: FieldDef[] = [
  { name: "provider", label: "Provider", kind: "select", options: [{ value: "meta", label: "Meta" }] },
  { name: "credential_label", label: "Account ID", kind: "text" },
  { name: "secret", label: "Credential", kind: "password" },
];

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); syncDraftIdentity("user-1"); });
afterEach(() => { localStorage.clear(); sessionStorage.clear(); });

describe("form draft isolation", () => {
  it("keeps only a validated provider selection across a reload in the same tab", () => {
    const draftKey = integrationDraftKey("client-1");
    syncDraftIdentity("user-1");
    const props = { open: true, onClose: vi.fn(), title: "Draft", draftKey, fields: integrationFields, onSubmit: vi.fn() };
    const { rerender } = render(<FormModal {...props} />);

    fireEvent.change(screen.getByLabelText("Account ID"), { target: { value: marker } });
    fireEvent.change(screen.getByLabelText("Credential"), { target: { value: marker } });
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "meta" } });

    expect(sessionStorage.getItem(currentKey(draftKey))).toBe(envelope({ provider: "meta" },
      JSON.parse(sessionStorage.getItem(currentKey(draftKey))!).savedAt));
    expect(localStorage.getItem(oldKey(draftKey))).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Leave this form?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Leave form" }));
    rerender(<FormModal {...props} open={false} />);
    rerender(<FormModal {...props} />);
    expect(screen.getByLabelText("Account ID")).toHaveValue("");
    expect(screen.getByLabelText("Credential")).toHaveValue("");
    expect(screen.getByLabelText("Provider")).toHaveValue("meta");
  });

  it("does not retain team names, usernames, or passwords", () => {
    const draftKey = teamMemberDraftKey("smm");
    const props = { open: true, onClose: vi.fn(), title: "Team", draftKey, fields: teamFields, onSubmit: vi.fn() };
    const { rerender } = render(<FormModal {...props} />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: marker } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: marker } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: marker } });
    expect(sessionStorage.getItem(currentKey(draftKey))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave form" }));
    rerender(<FormModal {...props} open={false} />);
    rerender(<FormModal {...props} />);
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.getByLabelText("Username")).toHaveValue("");
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("deletes every older draft family without reading any old value", () => {
    for (const key of ["team-member:smm", "team-member-v2:smm", "integration:c", "integration-v2:c",
      "contact:c", "lead:c", "billing:c", "member-contract-profile:m", "brand:c", "unknown"]) {
      localStorage.setItem(oldKey(key), JSON.stringify({ secret: marker }));
    }
    localStorage.setItem("unrelated:keep", "value");
    sessionStorage.setItem("aa-console:draft:v2:contact:c", JSON.stringify({ secret: marker }));
    sessionStorage.setItem("aa-console:draft:lead:c", JSON.stringify({ name: marker }));
    const retainedSafeDraft = envelope({ provider: "meta" });
    sessionStorage.setItem(currentKey("integration-v2:c"), retainedSafeDraft);
    const read = vi.spyOn(localStorage, "getItem");
    const sessionRead = vi.spyOn(sessionStorage, "getItem");
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    purgeLegacySensitiveDrafts();
    expect(read).not.toHaveBeenCalled();
    expect(sessionRead).not.toHaveBeenCalled();
    read.mockRestore();
    sessionRead.mockRestore();
    for (let index = 0; index < localStorage.length; index += 1) {
      expect(localStorage.key(index)).not.toMatch(/^aa-console:draft:/);
    }
    expect(Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)))
      .toContain("unrelated:keep");
    expect(sessionStorage.getItem("aa-console:draft:v2:contact:c")).toBeNull();
    expect(sessionStorage.getItem("aa-console:draft:lead:c")).toBeNull();
    expect(sessionStorage.getItem(currentKey("integration-v2:c"))).toBe(retainedSafeDraft);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
  });

  it("scrubs legacy drafts arriving after module load before writing a safe replacement", () => {
    const key = integrationDraftKey("client-1");
    const legacyLocal = oldKey("contact:client-1");
    const legacySession = "aa-console:draft:v2:billing:client-1";
    const calls: { action: "set" | "remove"; key: string }[] = [];
    const storage = (entries: [string, string][]) => {
      const store = new Map(entries);
      return {
        get length() { return store.size; },
        key: (index: number) => [...store.keys()][index] ?? null,
        getItem: (name: string) => store.get(name) ?? null,
        setItem: (name: string, value: string) => {
          calls.push({ action: "set" as const, key: name }); store.set(name, value);
        },
        removeItem: (name: string) => {
          calls.push({ action: "remove" as const, key: name }); store.delete(name);
        },
        clear: () => store.clear(),
      };
    };
    const local = storage([[legacyLocal, JSON.stringify({ email: marker })]]);
    const session = storage([
      ["aa-console:draft:session-user", "user-1"],
      [legacySession, JSON.stringify({ tax_id: marker })],
    ]);
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    try {
      writeDraft(key, { provider: "meta", secret: marker }, integrationFields);
      expect(local.getItem(legacyLocal)).toBeNull();
      expect(session.getItem(legacySession)).toBeNull();
      expect(readDraft(key, integrationFields)).toEqual({ provider: "meta" });
      const safeWrite = calls.findIndex((call) => call.action === "set" && call.key === currentKey(key));
      expect(safeWrite).toBeGreaterThanOrEqual(0);
      for (const legacyKey of [legacyLocal, legacySession]) {
        const removed = calls.findIndex((call) => call.action === "remove" && call.key === legacyKey);
        expect(removed).toBeGreaterThanOrEqual(0);
        expect(removed).toBeLessThan(safeWrite);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("scrubs a newly arrived legacy draft on safe reload without dropping the safe selection", () => {
    const key = integrationDraftKey("client-1");
    writeDraft(key, { provider: "meta" }, integrationFields);
    localStorage.setItem(oldKey("lead:client-1"), JSON.stringify({ phone: marker }));
    expect(readDraft(key, integrationFields)).toEqual({ provider: "meta" });
    expect(localStorage.getItem(oldKey("lead:client-1"))).toBeNull();
  });

  it("does not persist free text or seeded personal and financial values after a safe edit", () => {
    const key = "proof:client-1";
    const fields: FieldDef[] = [
      { name: "media_type", label: "Type", kind: "select", options: [{ value: "image", label: "Image" }] },
      { name: "source", label: "Source", kind: "text" },
      { name: "body", label: "Testimonial", kind: "textarea" },
      { name: "amount", label: "Amount", kind: "number" },
    ];
    const values = { media_type: "image", source: marker, body: marker, amount: "10000" };
    writeDraft(key, values, fields);
    expect(readDraft(key, fields)).toEqual({ media_type: "image" });
    expect(sessionStorage.getItem(currentKey(key))).not.toContain(marker);
    expect(localStorage.length).toBe(0);
  });

  it.each([
    ["contact:c", "email"], ["onboarding:contact:c", "phone"], ["lead:c", "name"],
    ["member-contract-profile:m", "tax_id"], ["billing:c", "monthly_amount"],
    ["finance-entry", "amount"], ["spend:c", "description"],
    ["agent:icp:c", "voice_of_customer"], ["business-context:c", "proof_testimonials"],
    ["ad-copy:a", "ad_link_url"], ["recruitment-brief:writer", "apply_url"],
    ["brand:c", "custom_css"], ["unknown-form:c", "name"],
  ])("denies the private field %s / %s", (key, name) => {
    const fields: FieldDef[] = [{ name, label: name, kind: "text" }];
    writeDraft(key, { [name]: marker }, fields);
    expect(sessionStorage.getItem(currentKey(key))).toBeNull();
  });

  it("validates selection options and full hex codes before saving or restoring", () => {
    const brandFields: FieldDef[] = [
      { name: "colour_primary", label: "Colour", kind: "text" },
      { name: "custom_css", label: "CSS", kind: "textarea" },
    ];
    writeDraft("brand:c", { colour_primary: "#ABC123", custom_css: marker }, brandFields);
    expect(readDraft("brand:c", brandFields)).toEqual({ colour_primary: "#ABC123" });
    writeDraft("brand:c", { colour_primary: marker, custom_css: marker }, brandFields);
    expect(sessionStorage.getItem(currentKey("brand:c"))).toBeNull();

    sessionStorage.setItem(currentKey("integration-v2:c"), envelope({ provider: marker, secret: marker }));
    expect(readDraft("integration-v2:c", integrationFields)).toBeUndefined();
    expect(sessionStorage.getItem(currentKey("integration-v2:c"))).toBeNull();
  });

  it.each([
    ["integration-v2:c", "provider", "meta", marker],
    ["idea-manual:c", "target_platform", "instagram", "act_123456789"],
    ["proof:c", "source_category", "customers", "private-client-account"],
    ["ad-copy:a", "ad_cta", "BOOK_NOW", "secret-as-option"],
  ])("refuses dynamic private select options for %s / %s", (key, name, safeValue, privateValue) => {
    const fields: FieldDef[] = [{ name, label: name, kind: "select", options: [
      { value: safeValue, label: "Safe" }, { value: privateValue, label: "Private" },
    ] }];
    writeDraft(key, { [name]: privateValue }, fields);
    expect(sessionStorage.getItem(currentKey(key))).toBeNull();
    sessionStorage.setItem(currentKey(key), envelope({ [name]: privateValue }));
    expect(readDraft(key, fields)).toBeUndefined();
    expect(sessionStorage.getItem(currentKey(key))).toBeNull();
    writeDraft(key, { [name]: safeValue }, fields);
    expect(readDraft(key, fields)).toEqual({ [name]: safeValue });
  });

  it("deletes unsafe source first even if saving its safe subset fails", () => {
    const key = currentKey("integration-v2:c");
    const store = new Map([[key, envelope({ provider: "meta", secret: marker })]]);
    vi.stubGlobal("sessionStorage", {
      getItem: (name: string) => name === "aa-console:draft:session-user" ? "user-1" : store.get(name) ?? null,
      removeItem: (name: string) => { store.delete(name); },
      setItem: () => { throw new DOMException("Storage unavailable", "QuotaExceededError"); },
    });
    try {
      expect(readDraft("integration-v2:c", integrationFields)).toEqual({ provider: "meta" });
      expect(store.has(key)).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("drops malformed and expired drafts and clears drafts on identity change", () => {
    const key = integrationDraftKey("c");
    sessionStorage.setItem(currentKey(key), "not-json");
    expect(readDraft(key, integrationFields)).toBeUndefined();
    expect(sessionStorage.getItem(currentKey(key))).toBeNull();
    sessionStorage.setItem(currentKey(key), envelope({ provider: "meta" }, Date.now() - 8 * 24 * 60 * 60 * 1000));
    expect(readDraft(key, integrationFields)).toBeUndefined();
    syncDraftIdentity("user-1");
    writeDraft(key, { provider: "meta" }, integrationFields);
    syncDraftIdentity("user-1");
    expect(readDraft(key, integrationFields)).toEqual({ provider: "meta" });
    syncDraftIdentity("user-2");
    expect(sessionStorage.getItem(currentKey(key))).toBeNull();
  });

  it("merges a partial safe draft with server values instead of blanking other fields", () => {
    const fields: FieldDef[] = [
      { name: "colour_primary", label: "Colour", kind: "text" },
      { name: "font_heading", label: "Font", kind: "text" },
    ];
    sessionStorage.setItem(currentKey("brand:c"), envelope({ colour_primary: "#ABC123" }));
    render(<FormModal open onClose={vi.fn()} title="Brand" draftKey="brand:c" fields={fields}
      initialValues={{ colour_primary: "#000000", font_heading: "Inter" }} onSubmit={vi.fn()} />);
    expect(screen.getByLabelText("Colour")).toHaveValue("#ABC123");
    expect(screen.getByLabelText("Font")).toHaveValue("Inter");
  });

  it("keeps private edits through refresh and confirms before an AI draft replaces them", () => {
    const fields: FieldDef[] = [
      { name: "note", label: "Note", kind: "textarea" },
      { name: "role_title", label: "Role", kind: "text" },
    ];
    const props = { open: true, onClose: vi.fn(), title: "Contact", draftKey: "contact:c", fields, onSubmit: vi.fn() };
    const { rerender } = render(<FormModal {...props} initialValues={{ note: "Original", role_title: "Owner" }} />);
    fireEvent.change(screen.getByLabelText("Note"), { target: { value: marker } });
    rerender(<FormModal {...props} initialValues={{ note: "Server refresh", role_title: "Manager" }} />);
    expect(screen.getByLabelText("Note")).toHaveValue(marker);
    expect(screen.getByLabelText("Role")).toHaveValue("Manager");
    expect(sessionStorage.getItem(currentKey("contact:c"))).toBeNull();

    const generated = { note: "Generated", role_title: "Director" };
    rerender(<FormModal {...props} initialValues={generated} resetKey={generated} />);
    expect(screen.getByLabelText("Note")).toHaveValue(marker);
    expect(screen.getByLabelText("Role")).toHaveValue("Manager");
    expect(screen.getByText("Replace your edits with the AI draft?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
    rerender(<FormModal {...props} initialValues={{ ...generated }} resetKey={generated} />);
    expect(screen.getByLabelText("Note")).toHaveValue(marker);
    expect(screen.getByLabelText("Role")).toHaveValue("Manager");

    const nextGenerated = { note: "Second generated", role_title: "Principal" };
    rerender(<FormModal {...props} initialValues={nextGenerated} resetKey={nextGenerated} />);
    expect(screen.getByLabelText("Note")).toHaveValue(marker);
    fireEvent.click(screen.getByRole("button", { name: "Use AI draft" }));
    expect(screen.getByLabelText("Note")).toHaveValue("Second generated");
    expect(screen.getByLabelText("Role")).toHaveValue("Principal");
  });

  it("retains the safe draft if AI output is declined and clears it only when accepted", () => {
    const fields: FieldDef[] = [
      { name: "provider", label: "Provider", kind: "select", options: [{ value: "meta", label: "Meta" }, { value: "google", label: "Google" }] },
      { name: "label", label: "Private label", kind: "text" },
    ];
    const draftKey = integrationDraftKey("client-1");
    const props = { open: true, onClose: vi.fn(), title: "Integration", draftKey, fields, onSubmit: vi.fn() };
    const { rerender } = render(<FormModal {...props} />);
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "meta" } });
    fireEvent.change(screen.getByLabelText("Private label"), { target: { value: marker } });
    expect(readDraft(draftKey, fields)).toEqual({ provider: "meta" });

    const generated = { provider: "google", label: "AI label" };
    rerender(<FormModal {...props} initialValues={generated} resetKey={generated} />);
    fireEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
    expect(readDraft(draftKey, fields)).toEqual({ provider: "meta" });
    expect(screen.getByLabelText("Private label")).toHaveValue(marker);

    const nextGenerated = { provider: "google", label: "New AI label" };
    rerender(<FormModal {...props} initialValues={nextGenerated} resetKey={nextGenerated} />);
    fireEvent.click(screen.getByRole("button", { name: "Use AI draft" }));
    expect(readDraft(draftKey, fields)).toBeUndefined();
    expect(screen.getByLabelText("Provider")).toHaveValue("google");
    expect(screen.getByLabelText("Private label")).toHaveValue("New AI label");
  });

  it("guards Cancel, Escape, backdrop, and close button before discarding private edits", () => {
    const fields: FieldDef[] = [{ name: "note", label: "Private note", kind: "textarea" }];
    const onClose = vi.fn();
    render(<FormModal open onClose={onClose} title="Private form" draftKey="contact:c"
      fields={fields} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Private note"), { target: { value: marker } });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Leave this form?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Private note")).toHaveValue(marker);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Leave this form?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

    fireEvent.click(screen.getAllByRole("button", { name: "Close dialog" })[0]);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText("Leave this form?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

    fireEvent.click(screen.getAllByRole("button", { name: "Close dialog" })[1]);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Leave form" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FormModal } from "./FormModal";
import { purgeLegacySensitiveDrafts } from "./draftStorage";
import type { FieldDef } from "./fields";

const marker = "opaque-private-marker";
const teamFields: FieldDef[] = [
  { name: "name", label: "Name", kind: "text" },
  { name: "password", label: "Password", kind: "password" },
];
const integrationFields: FieldDef[] = [
  { name: "provider", label: "Provider", kind: "text" },
  { name: "secret", label: "Credential", kind: "password" },
];

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("sensitive form drafts", () => {
  it.each([
    { name: "Team", draftKey: "team-member:smm", fields: teamFields, sensitiveLabel: "Password", safeLabel: "Name" },
    { name: "Vault", draftKey: "integration:example", fields: integrationFields, sensitiveLabel: "Credential", safeLabel: "Provider" },
  ])("never persists or restores the $name sensitive field", ({ draftKey, fields, sensitiveLabel, safeLabel }) => {
    const onClose = vi.fn();
    const props = { open: true, onClose, title: "Draft", draftKey, fields, onSubmit: vi.fn() };
    const { rerender } = render(<FormModal {...props} />);

    fireEvent.change(screen.getByLabelText(new RegExp(`^${sensitiveLabel}`)), { target: { value: marker } });
    fireEvent.change(screen.getByLabelText(safeLabel), { target: { value: "Safe value" } });
    expect(localStorage.getItem(`aa-console:draft:${draftKey}`)).not.toContain(marker);
    expect(localStorage.getItem(`aa-console:draft:${draftKey}`)).toContain("Safe value");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<FormModal {...props} open={false} />);
    rerender(<FormModal {...props} />);
    expect(screen.getByLabelText(new RegExp(`^${sensitiveLabel}`))).toHaveValue("");
    expect(screen.getByLabelText(safeLabel)).toHaveValue("Safe value");
  });

  it("removes old Team and integration drafts without reading or logging their values", () => {
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    localStorage.setItem("aa-console:draft:team-member:editors", JSON.stringify({ name: "Editor", password: marker }));
    localStorage.setItem("aa-console:draft:integration:example", JSON.stringify({ provider: "meta", secret: marker }));
    localStorage.setItem("aa-console:draft:brand:example", JSON.stringify({ name: "Brand draft" }));

    purgeLegacySensitiveDrafts();

    expect(localStorage.getItem("aa-console:draft:team-member:editors")).toBeNull();
    expect(localStorage.getItem("aa-console:draft:integration:example")).toBeNull();
    expect(localStorage.getItem("aa-console:draft:brand:example")).toContain("Brand draft");
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
  });

  it("scrubs a legacy password from a generic draft before restoring it", () => {
    const fields: FieldDef[] = [
      { name: "name", label: "Name", kind: "text" },
      { name: "private", label: "Private", kind: "password" },
    ];
    localStorage.setItem("aa-console:draft:generic", JSON.stringify({ name: "Safe value", private: marker }));

    render(<FormModal open onClose={vi.fn()} title="Draft" fields={fields}
      draftKey="generic" onSubmit={vi.fn()} />);

    expect(screen.getByLabelText("Name")).toHaveValue("Safe value");
    expect(screen.getByLabelText("Private")).toHaveValue("");
    expect(localStorage.getItem("aa-console:draft:generic")).toBe(JSON.stringify({ name: "Safe value" }));
  });
});

import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Modal } from "./Modal";
import { FieldControl } from "./forms/fields";

it("keeps keyboard focus inside a dialog and returns it to the opener", async () => {
  const user = userEvent.setup();
  function Example() {
    const [open, setOpen] = useState(false);
    return <>
      <button onClick={() => setOpen(true)}>Open review</button>
      <button>Outside action</button>
      <Modal open={open} onClose={() => setOpen(false)} title="Review exact version">
        <input aria-label="Review reason" />
        <button>Approve</button>
      </Modal>
    </>;
  }
  render(<Example />);
  const opener = screen.getByRole("button", { name: "Open review" });
  await user.click(opener);
  const dialog = screen.getByRole("dialog", { name: "Review exact version" });
  const close = within(dialog).getByRole("button", { name: "Close dialog" });
  expect(dialog).toHaveFocus();
  await user.tab();
  expect(close).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("textbox", { name: "Review reason" })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole("button", { name: "Approve" })).toHaveFocus();
  await user.tab();
  expect(close).toHaveFocus();
  await user.tab({ shift: true });
  expect(screen.getByRole("button", { name: "Approve" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});

it("associates a required field's instruction with the control", () => {
  render(<FieldControl field={{ name: "route", label: "Route package", kind: "select",
    required: true, hint: "Choose the exact approved route version.",
    options: [{ value: "route-1", label: "Organic v1" }] }}
    value="" onChange={vi.fn()} />);
  const select = screen.getByRole("combobox", { name: "Route package" });
  expect(select).toHaveAttribute("aria-required", "true");
  expect(select).toHaveAccessibleDescription("Choose the exact approved route version.");
});

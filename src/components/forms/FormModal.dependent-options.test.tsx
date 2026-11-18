import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { FormModal } from "./FormModal";

it("reports initial and changed values for dependent request options", async () => {
  const changed = vi.fn();
  render(<FormModal open onClose={() => {}} title="Assign work"
    fields={[{ name: "client_id", label: "Client", kind: "select",
      options: [{ value: "client-1", label: "Client one" }] }]}
    onValuesChange={changed} onSubmit={async () => {}} />);
  await waitFor(() => expect(changed).toHaveBeenCalledWith({ client_id: "" }));
  fireEvent.change(screen.getByLabelText("Client"), { target: { value: "client-1" } });
  await waitFor(() => expect(changed).toHaveBeenCalledWith({ client_id: "client-1" }));
});

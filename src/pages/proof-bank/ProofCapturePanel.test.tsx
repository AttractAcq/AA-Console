import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";

const { from, readConfigs, readPages, route } = vi.hoisted(() => ({
  from: vi.fn(), readConfigs: vi.fn(), readPages: vi.fn(), route: { capture: "automated_requests" },
}));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));
vi.mock("react-router-dom", () => ({
  useSearchParams: () => [new URLSearchParams(`capture=${route.capture}`), vi.fn()],
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("./ProofCaptureDelivery", () => ({ ProofCaptureDelivery: () => null }));
vi.mock("./ProofIntegrationCapture", () => ({ ProofIntegrationCapture: () => null }));
vi.mock("./ProofOutcomeConsentPanel", () => ({
  ProofOutcomeConsentPanel: ({ clientId }: { clientId: string }) => {
    const [open, setOpen] = useState(false);
    return <div><button onClick={() => setOpen(true)}>Show consent detail</button>
      {open && <span>Consent detail for {clientId}</span>}</div>;
  },
}));
vi.mock("./ProofServiceOutcomePanel", () => ({ ProofServiceOutcomePanel: () => null }));
vi.mock("../../components/proof/AddProofModal", () => ({ AddProofModal: () => null }));
vi.mock("../../components/forms/FormModal", () => ({
  FormModal: ({ open, initialValues }: { open: boolean; initialValues: { name: string } }) =>
    open ? <div role="dialog">Editing {initialValues.name}</div> : null,
}));

import { ProofCapturePanel } from "./ProofCapturePanel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  route.capture = "automated_requests";
  from.mockImplementation((table: string) => ({
    select: () => ({
      eq: (_field: string, clientId: string) => table === "proof_capture_configs"
        ? { order: () => readConfigs(clientId) }
        : readPages(clientId),
    }),
  }));
  readPages.mockResolvedValue({ data: [], error: null });
});

it("resets client-specific outcome child state on client navigation", async () => {
  route.capture = "outcome_followup";
  readConfigs.mockResolvedValue({ data: [], error: null });
  const view = render(<ProofCapturePanel clientId="client-a" />);
  fireEvent.click(screen.getByRole("button", { name: "Show consent detail" }));
  expect(screen.getByText("Consent detail for client-a")).toBeInTheDocument();
  view.rerender(<ProofCapturePanel clientId="client-b" />);
  expect(screen.queryByText("Consent detail for client-a")).not.toBeInTheDocument();
});

it("hides previous-client setups and closes their edit form before a new read completes", async () => {
  const next = deferred<{ data: null; error: { message: string } }>();
  readConfigs.mockImplementation((clientId: string) => clientId === "client-a"
    ? Promise.resolve({ data: [{ id: "setup-a", client_id: "client-a",
      method: "automated_requests", name: "Private A setup", instructions: "Private A instructions" }], error: null })
    : next.promise);
  const view = render(<ProofCapturePanel clientId="client-a" />);
  expect(await screen.findByText("Private A setup")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Private A setup");
  view.rerender(<ProofCapturePanel clientId="client-b" />);
  expect(screen.queryByText("Private A setup")).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await act(async () => next.resolve({ data: null, error: { message: "Read denied" } }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Read denied");
  expect(screen.queryByText("Private A instructions")).not.toBeInTheDocument();
});

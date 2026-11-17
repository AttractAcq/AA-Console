import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { from, readConfigs, readPages } = vi.hoisted(() => ({
  from: vi.fn(), readConfigs: vi.fn(), readPages: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({ supabase: { from } }));
vi.mock("react-router-dom", () => ({
  useSearchParams: () => [new URLSearchParams("capture=automated_requests"), vi.fn()],
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("./ProofCaptureDelivery", () => ({ ProofCaptureDelivery: () => null }));
vi.mock("./ProofIntegrationCapture", () => ({ ProofIntegrationCapture: () => null }));
vi.mock("./ProofOutcomeConsentPanel", () => ({ ProofOutcomeConsentPanel: () => null }));
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
  from.mockImplementation((table: string) => ({
    select: () => ({
      eq: (_field: string, clientId: string) => table === "proof_capture_configs"
        ? { order: () => readConfigs(clientId) }
        : readPages(clientId),
    }),
  }));
  readPages.mockResolvedValue({ data: [], error: null });
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

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { from, rpc, useParams } = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), useParams: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({ useParams }));
vi.mock("../../components/MetricsBackfill", () => ({ MetricsBackfill: () => null }));

// Deliberately use the real FormModal. Its in-flight handleSubmit invokes
// onSaved and onClose after the database promise resolves, even if the route
// and the visible form have changed since the operator pressed Save.
import { IntegrationsPanel } from "./IntegrationsPanel";

const base = {
  credential_secret_id: "vault-reference-only",
  provider: "meta",
  credential_label: "act_123",
  access_level: null,
  status: "connected",
  ingest_enabled: false,
  last_checked_at: null,
  token_expires_at: null,
  ad_account_id: "act_123",
  meta_pixel_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

it("keeps B's real Meta dialog open when A's earlier save completes", async () => {
  let selectedClient = "client-1";
  let finishA: ((value: { error: null }) => void) | undefined;
  const writes: Array<Array<[string, string]>> = [];
  useParams.mockImplementation(() => ({ clientId: selectedClient }));
  from.mockImplementation(() => {
    let readClient = "";
    const query = {
      select: () => query,
      eq: (field: string, value: string) => { if (field === "client_id") readClient = value; return query; },
      order: async () => ({
        data: [{ ...base, id: readClient === "client-1" ? "meta-a" : "meta-b", client_id: readClient,
          meta_page_id: readClient === "client-1" ? "111" : "222" }],
        error: null,
      }),
      update: () => {
        const filters: Array<[string, string]> = [];
        writes.push(filters);
        const updateQuery = {
          eq: (field: string, value: string) => {
            filters.push([field, value]);
            return filters.length === 2
              ? new Promise<{ error: null }>((resolve) => { finishA = resolve; })
              : updateQuery;
          },
        };
        return updateQuery;
      },
    };
    return query;
  });

  const rendered = render(<IntegrationsPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Page 111" }));
  const aDialog = screen.getByRole("dialog", { name: "Meta ad settings" });
  fireEvent.change(within(aDialog).getByLabelText(/Facebook page ID/), { target: { value: "333" } });
  fireEvent.click(within(aDialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(writes).toEqual([[["id", "meta-a"], ["client_id", "client-1"]]]));

  selectedClient = "client-2";
  rendered.rerender(<IntegrationsPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Page 222" }));
  const bDialog = screen.getByRole("dialog", { name: "Meta ad settings" });
  expect(within(bDialog).getByLabelText(/Facebook page ID/)).toHaveValue("222");

  await act(async () => { finishA?.({ error: null }); });
  expect(screen.getByRole("dialog", { name: "Meta ad settings" })).toBeInTheDocument();
  expect(within(screen.getByRole("dialog", { name: "Meta ad settings" }))
    .getByLabelText(/Facebook page ID/)).toHaveValue("222");
  expect(writes).toHaveLength(1);
});

it("keeps a new A Meta dialog open after A→B→A while A's old save finishes", async () => {
  let selectedClient = "client-1";
  let finishOldA: ((value: { error: null }) => void) | undefined;
  useParams.mockImplementation(() => ({ clientId: selectedClient }));
  from.mockImplementation(() => {
    let readClient = "";
    const query = {
      select: () => query,
      eq: (field: string, value: string) => { if (field === "client_id") readClient = value; return query; },
      order: async () => ({ data: [{ ...base, id: `meta-${readClient}`, client_id: readClient,
        meta_page_id: readClient === "client-1" ? "111" : "222" }], error: null }),
      update: () => {
        let count = 0;
        const updateQuery = {
          eq: () => ++count === 2
            ? new Promise<{ error: null }>((resolve) => { finishOldA = resolve; })
            : updateQuery,
        };
        return updateQuery;
      },
    };
    return query;
  });

  const rendered = render(<IntegrationsPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Page 111" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Meta ad settings" }))
    .getByRole("button", { name: "Save" }));
  await waitFor(() => expect(finishOldA).toBeTypeOf("function"));

  selectedClient = "client-2";
  rendered.rerender(<IntegrationsPanel />);
  await screen.findByRole("button", { name: "Page 222" });
  selectedClient = "client-1";
  rendered.rerender(<IntegrationsPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Page 111" }));
  expect(screen.getByRole("dialog", { name: "Meta ad settings" })).toBeInTheDocument();

  await act(async () => { finishOldA?.({ error: null }); });
  expect(screen.getByRole("dialog", { name: "Meta ad settings" })).toBeInTheDocument();
});

it("does not carry A's in-flight secret or completion into B's real Add Integration form", async () => {
  let selectedClient = "client-1";
  let finishA: ((value: { error: null }) => void) | undefined;
  useParams.mockImplementation(() => ({ clientId: selectedClient }));
  from.mockImplementation(() => {
    let readClient = "";
    const query = {
      select: () => query,
      eq: (_field: string, value: string) => { readClient = value; return query; },
      order: async () => ({ data: [{ ...base, id: `meta-${readClient}`, client_id: readClient,
        meta_page_id: readClient === "client-1" ? "111" : "222" }], error: null }),
    };
    return query;
  });
  rpc.mockImplementation(() => new Promise<{ error: null }>((resolve) => { finishA = resolve; }));

  const rendered = render(<IntegrationsPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Add" }));
  const aDialog = screen.getByRole("dialog", { name: "Add Integration" });
  fireEvent.change(within(aDialog).getByLabelText(/Provider/), { target: { value: "meta" } });
  fireEvent.change(within(aDialog).getByLabelText(/Credential/), { target: { value: "a-secret" } });
  fireEvent.click(within(aDialog).getByRole("button", { name: "Connect" }));
  await waitFor(() => expect(rpc).toHaveBeenCalledWith("admin_store_integration_credential",
    expect.objectContaining({ p_client_id: "client-1", p_secret: "a-secret" })));

  selectedClient = "client-2";
  rendered.rerender(<IntegrationsPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Add" }));
  const bDialog = screen.getByRole("dialog", { name: "Add Integration" });
  expect(within(bDialog).getByLabelText(/Credential/)).toHaveValue("");
  expect(within(bDialog).getByLabelText(/Provider/)).toHaveValue("");

  await act(async () => { finishA?.({ error: null }); });
  expect(screen.getByRole("dialog", { name: "Add Integration" })).toBeInTheDocument();
  expect(within(screen.getByRole("dialog", { name: "Add Integration" }))
    .getByLabelText(/Credential/)).toHaveValue("");
  expect(rpc).toHaveBeenCalledTimes(1);
});

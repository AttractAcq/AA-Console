import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const { from, rpc, useParams, formModalProps } = vi.hoisted(() => ({
  from: vi.fn(), rpc: vi.fn(), useParams: vi.fn(), formModalProps: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({ supabase: { from, rpc } }));
vi.mock("react-router-dom", () => ({ useParams }));
vi.mock("../../components/MetricsBackfill", () => ({ MetricsBackfill: () => null }));
vi.mock("../../components/forms/FormModal", () => ({
  FormModal: (props: unknown) => { formModalProps(props); return null; },
}));

import { IntegrationsPanel } from "./IntegrationsPanel";

const CHECKED_AT = "2027-01-01T12:00:00Z";
const base = {
  client_id: "client-1", credential_secret_id: "vault-reference-only",
  credential_label: "account-1", access_level: null, status: "connected",
  ingest_enabled: false, last_checked_at: CHECKED_AT, token_expires_at: null,
  ad_account_id: null, meta_page_id: null, meta_pixel_id: null,
};
const defaultRows = [
  { ...base, id: "meta-1", provider: "meta", ingest_enabled: true },
  { ...base, id: "google-1", provider: "google_business" },
  { ...base, id: "resend-1", provider: "resend" },
  { ...base, id: "instagram-1", provider: "instagram", status: "revoked", last_checked_at: null },
];

type CapturedModal = {
  title: string;
  open: boolean;
  initialValues: { meta_page_id: string; meta_pixel_id: string };
  onSubmit: (values: { meta_page_id: string; meta_pixel_id: string }) => Promise<void>;
  onSaved: () => Promise<void>;
};

function latestAdModal(): CapturedModal {
  return formModalProps.mock.calls
    .map(([props]) => props as CapturedModal)
    .filter((props) => props.title === "Meta ad settings")
    .at(-1)!;
}

function latestAddModal(): {
  open: boolean;
  onSubmit: (values: Record<string, string>) => Promise<void>;
} {
  return formModalProps.mock.calls
    .map(([props]) => props as { title: string; open: boolean; onSubmit: (values: Record<string, string>) => Promise<void> })
    .filter((props) => props.title === "Add Integration")
    .at(-1)!;
}

function responseFor(rows: unknown) {
  from.mockImplementation(() => {
    const query = {
      select: () => query,
      eq: () => query,
      order: async () => ({ data: rows, error: null }),
    };
    return query;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
  responseFor(defaultRows);
});

it("does not present the shared check timestamp as token proof or a completed sync", async () => {
  render(<IntegrationsPanel />);
  // Both metrics_ingest and token_health update last_checked_at. A row with
  // that value cannot identify which check ran, including for Meta.
  expect(await screen.findAllByText(/Last recorded integration activity/)).toHaveLength(3);
  expect(screen.queryByText(/Token checked/)).not.toBeInTheDocument();
  expect(screen.queryByText(/On · last/)).not.toBeInTheDocument();
  expect(screen.getByText(/Provider health unknown. Exact location access/)).toBeInTheDocument();
  expect(screen.getByText(/Provider health unknown. This row does not verify/)).toBeInTheDocument();
  expect(screen.getByText(/Blocked by integration status/)).toBeInTheDocument();
});

it("uses the onboarding evidence contract for Meta and Instagram without exposing the Vault reference", async () => {
  render(<IntegrationsPanel />);
  const evidence = await screen.findByRole("region", { name: "Provider access evidence" });
  expect(evidence).toHaveTextContent("meta · Blocked");
  expect(evidence).toHaveTextContent("instagram · Blocked");
  expect(evidence).toHaveTextContent("A Meta ad account ID shaped like act_123 is required");
  expect(evidence).toHaveTextContent("instagram status is revoked");
  expect(evidence).toHaveTextContent("Required scopes: Unknown");
  expect(evidence).toHaveTextContent("Action rights: Unknown");
  expect(evidence).toHaveTextContent("exact-version Approval Inbox approval");
  expect(evidence).not.toHaveTextContent("vault-reference-only");
  expect(from.mock.calls[0]?.[0]).toBe("client_integrations");
});

it("holds a connected-looking provider row with no Vault reference and never calls a shaped ID verified", async () => {
  responseFor([
    { ...base, id: "meta-1", provider: "meta", credential_secret_id: null, credential_label: "act_123", ad_account_id: "act_123", ingest_enabled: true },
    { ...base, id: "ig-1", provider: "instagram", credential_label: "17841400000000000", ingest_enabled: true },
  ]);
  render(<IntegrationsPanel />);
  const evidence = await screen.findByRole("region", { name: "Provider access evidence" });
  expect(evidence).toHaveTextContent("No Vault credential reference is recorded for meta");
  expect(evidence).toHaveTextContent("Account act_123 is configured, but no provider account readback is recorded");
  expect(evidence).toHaveTextContent("Required instagram scopes have no persisted provider-specific diagnostic");
  expect(evidence).not.toHaveTextContent("Ready");
});

it("fails closed on cross-client evidence instead of displaying it on the selected client", async () => {
  responseFor([{ ...base, id: "other-1", client_id: "client-2", provider: "meta" }]);
  render(<IntegrationsPanel />);
  expect(await screen.findByRole("alert")).toHaveTextContent("another client's data");
  expect(screen.queryByRole("region", { name: "Provider access evidence" })).not.toBeInTheDocument();
});

it("does not let a late response from a previous client replace the current client's evidence", async () => {
  let selectedClient = "client-1";
  let finishFirst: ((value: { data: unknown[]; error: null }) => void) | undefined;
  useParams.mockImplementation(() => ({ clientId: selectedClient }));
  from.mockImplementation(() => {
    let queryClient = "";
    const query = {
      select: () => query,
      eq: (_field: string, value: string) => { queryClient = value; return query; },
      order: () => queryClient === "client-1"
        ? new Promise<{ data: unknown[]; error: null }>((resolve) => { finishFirst = resolve; })
        : Promise.resolve({ data: [{ ...base, id: "ig-b", client_id: "client-2", provider: "instagram", credential_label: "17841400000000000" }], error: null }),
    };
    return query;
  });

  const rendered = render(<IntegrationsPanel />);
  selectedClient = "client-2";
  rendered.rerender(<IntegrationsPanel />);
  const evidence = await screen.findByRole("region", { name: "Provider access evidence" });
  expect(evidence).toHaveTextContent("instagram");
  expect(evidence).toHaveTextContent("17841400000000000");
  await act(async () => { finishFirst?.({ data: [{ ...base, id: "meta-a", provider: "meta" }], error: null }); });
  await waitFor(() => expect(screen.getByRole("region", { name: "Provider access evidence" })).toHaveTextContent("17841400000000000"));
  expect(screen.getByRole("region", { name: "Provider access evidence" })).not.toHaveTextContent("meta-a");
  expect(within(evidence).getByText(/No meta integration is visible for this client/)).toBeInTheDocument();
});

it("closes client A's Meta dialog on route change, rejects its stale submit, and scopes an in-flight B update", async () => {
  let selectedClient = "client-1";
  let finishUpdate: ((value: { data: Array<{ id: string; client_id: string; meta_page_id: string; meta_pixel_id: null }>; error: null }) => void) | undefined;
  const writes: Array<{ payload: Record<string, unknown>; filters: Array<[string, string]> }> = [];
  useParams.mockImplementation(() => ({ clientId: selectedClient }));
  from.mockImplementation(() => {
    let readClient = "";
    const query = {
      select: () => query,
      eq: (field: string, value: string) => { if (field === "client_id") readClient = value; return query; },
      order: async () => ({
        data: [{
          ...base,
          id: readClient === "client-1" ? "meta-a" : "meta-b",
          client_id: readClient,
          provider: "meta",
          meta_page_id: readClient === "client-1" ? "111" : "222",
        }],
        error: null,
      }),
      update: (payload: Record<string, unknown>) => {
        const write = { payload, filters: [] as Array<[string, string]> };
        writes.push(write);
        const updateQuery = {
          eq: (field: string, value: string) => {
            write.filters.push([field, value]);
            return updateQuery;
          },
          select: () => new Promise<{ data: Array<{ id: string; client_id: string; meta_page_id: string; meta_pixel_id: null }>; error: null }>((resolve) => { finishUpdate = resolve; }),
        };
        return updateQuery;
      },
    };
    return query;
  });

  const rendered = render(<IntegrationsPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Page 111" }));
  const aModal = latestAdModal();
  expect(aModal.open).toBe(true);
  expect(aModal.initialValues.meta_page_id).toBe("111");

  selectedClient = "client-2";
  rendered.rerender(<IntegrationsPanel />);
  await screen.findByRole("button", { name: "Page 222" });
  expect(latestAdModal().open).toBe(false);
  expect(latestAdModal().initialValues.meta_page_id).toBe("");
  expect(screen.queryByRole("button", { name: "Page 111" })).not.toBeInTheDocument();
  await expect(aModal.onSubmit({ meta_page_id: "333", meta_pixel_id: "" }))
    .rejects.toThrow("No current-client integration selected");
  expect(writes).toHaveLength(0);

  fireEvent.click(screen.getByRole("button", { name: "Page 222" }));
  const bModal = latestAdModal();
  expect(bModal.open).toBe(true);
  const save = bModal.onSubmit({ meta_page_id: "444", meta_pixel_id: "" });
  expect(writes).toEqual([{
    payload: { meta_page_id: "444", meta_pixel_id: null },
    filters: [["id", "meta-b"], ["client_id", "client-2"]],
  }]);

  selectedClient = "client-1";
  rendered.rerender(<IntegrationsPanel />);
  await screen.findByRole("button", { name: "Page 111" });
  expect(latestAdModal().open).toBe(false);
  await act(async () => { finishUpdate?.({ data: [{ id: "meta-b", client_id: "client-2", meta_page_id: "444", meta_pixel_id: null }], error: null }); await save; });
  await bModal.onSaved();
  expect(writes).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Page 222" })).not.toBeInTheDocument();
  await expect(aModal.onSubmit({ meta_page_id: "555", meta_pixel_id: "" }))
    .rejects.toThrow("No current-client integration selected");
  expect(writes).toHaveLength(1);
});

it("keeps client B's pending sync control disabled when client A's older update finishes", async () => {
  let selectedClient = "client-1";
  const finish = new Map<string, (value: { data: Array<{ id: string; client_id: string; ingest_enabled: boolean }>; error: null }) => void>();
  const writes: Array<Array<[string, string]>> = [];
  useParams.mockImplementation(() => ({ clientId: selectedClient }));
  from.mockImplementation(() => {
    let readClient = "";
    const query = {
      select: () => query,
      eq: (field: string, value: string) => { if (field === "client_id") readClient = value; return query; },
      order: async () => ({
        data: [{ ...base, id: `meta-${readClient}`, client_id: readClient, provider: "meta" }],
        error: null,
      }),
      update: () => {
        const filters: Array<[string, string]> = [];
        writes.push(filters);
        const updateQuery = {
          eq: (field: string, value: string) => {
            filters.push([field, value]);
            return updateQuery;
          },
          select: () => new Promise<{ data: Array<{ id: string; client_id: string; ingest_enabled: boolean }>; error: null }>((resolve) => {
            finish.set(filters.find(([field]) => field === "client_id")![1], resolve);
          }),
        };
        return updateQuery;
      },
    };
    return query;
  });

  const rendered = render(<IntegrationsPanel />);
  fireEvent.click(await screen.findByRole("switch", { name: "Daily sync for meta" }));
  expect(screen.getByRole("switch", { name: "Daily sync for meta" })).toBeDisabled();

  selectedClient = "client-2";
  rendered.rerender(<IntegrationsPanel />);
  const bSwitch = await screen.findByRole("switch", { name: "Daily sync for meta" });
  await waitFor(() => expect(bSwitch).not.toBeDisabled());
  fireEvent.click(bSwitch);
  expect(bSwitch).toBeDisabled();
  expect(writes).toEqual([
    [["id", "meta-client-1"], ["client_id", "client-1"]],
    [["id", "meta-client-2"], ["client_id", "client-2"]],
  ]);

  await act(async () => { finish.get("client-1")?.({ data: [{ id: "meta-client-1", client_id: "client-1", ingest_enabled: true }], error: null }); });
  expect(bSwitch).toBeDisabled();
  await act(async () => { finish.get("client-2")?.({ data: [{ id: "meta-client-2", client_id: "client-2", ingest_enabled: true }], error: null }); });
  await waitFor(() => expect(bSwitch).not.toBeDisabled());
});

it("keeps a returned client's sync pending and ignores an old visit's failed rollback", async () => {
  let selectedClient = "client-1";
  let aServerEnabled = false;
  const finish = new Map<string, (value: { data: Array<{ id: string; client_id: string; ingest_enabled: boolean }> | null; error: { message: string } | null }) => void>();
  useParams.mockImplementation(() => ({ clientId: selectedClient }));
  from.mockImplementation(() => {
    let readClient = "";
    const query = {
      select: () => query,
      eq: (field: string, value: string) => { if (field === "client_id") readClient = value; return query; },
      order: async () => ({ data: [{ ...base, id: `meta-${readClient}`, client_id: readClient,
        provider: "meta", ingest_enabled: readClient === "client-1" ? aServerEnabled : false }], error: null }),
      update: () => {
        let updateClient = "";
        const updateQuery = {
          eq: (field: string, value: string) => {
            if (field === "client_id") updateClient = value;
            return updateQuery;
          },
          select: () => new Promise<{ data: Array<{ id: string; client_id: string; ingest_enabled: boolean }> | null; error: { message: string } | null }>((resolve) => { finish.set(updateClient, resolve); }),
        };
        return updateQuery;
      },
    };
    return query;
  });

  const rendered = render(<IntegrationsPanel />);
  fireEvent.click(await screen.findByRole("switch", { name: "Daily sync for meta" }));
  expect(screen.getByRole("switch", { name: "Daily sync for meta" })).toBeDisabled();

  selectedClient = "client-2";
  rendered.rerender(<IntegrationsPanel />);
  const bSwitch = await screen.findByRole("switch", { name: "Daily sync for meta" });
  await waitFor(() => expect(bSwitch).not.toBeDisabled());
  fireEvent.click(bSwitch);
  expect(bSwitch).toBeDisabled();

  // A fresh A read sees a newer server value while A's earlier write is still pending.
  aServerEnabled = true;
  selectedClient = "client-1";
  rendered.rerender(<IntegrationsPanel />);
  const aSwitch = await screen.findByRole("switch", { name: "Daily sync for meta" });
  expect(aSwitch).toHaveAttribute("aria-checked", "true");
  expect(aSwitch).toBeDisabled();

  await act(async () => { finish.get("client-1")?.({ data: null, error: { message: "Old visit denied" } }); });
  await waitFor(() => expect(aSwitch).not.toBeDisabled());
  expect(aSwitch).toHaveAttribute("aria-checked", "true");
  expect(screen.queryByText("Old visit denied")).not.toBeInTheDocument();

  selectedClient = "client-2";
  rendered.rerender(<IntegrationsPanel />);
  expect(await screen.findByRole("switch", { name: "Daily sync for meta" })).toBeDisabled();
  await act(async () => { finish.get("client-2")?.({ data: [{ id: "meta-client-2", client_id: "client-2", ingest_enabled: true }], error: null }); });
  await waitFor(() => expect(screen.getByRole("switch", { name: "Daily sync for meta" })).not.toBeDisabled());
});

it.each([
  { label: "zero rows", returned: [] },
  { label: "another client's row", returned: [{ id: "meta-1", client_id: "client-2", ingest_enabled: true }] },
])("reconciles an unconfirmed same-visit sync update: $label", async ({ returned }) => {
  const updateSelect = vi.fn(async () => ({ data: returned, error: null }));
  from.mockImplementation(() => {
    const query = {
      select: () => query,
      eq: () => query,
      order: async () => ({ data: [{ ...base, id: "meta-1", provider: "meta" }], error: null }),
      update: () => {
        const updateQuery = { eq: () => updateQuery, select: updateSelect };
        return updateQuery;
      },
    };
    return query;
  });

  render(<IntegrationsPanel />);
  const toggle = await screen.findByRole("switch", { name: "Daily sync for meta" });
  fireEvent.click(toggle);
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("not confirmed for this client"));
  expect(toggle).toHaveAttribute("aria-checked", "false");
  expect(toggle).not.toBeDisabled();
  expect(updateSelect).toHaveBeenCalledWith("id, client_id, ingest_enabled");
});

it("keeps a same-visit sync change only after one exact-client returned row", async () => {
  const updateSelect = vi.fn(async () => ({
    data: [{ id: "meta-1", client_id: "client-1", ingest_enabled: true }], error: null,
  }));
  from.mockImplementation(() => {
    const query = {
      select: () => query,
      eq: () => query,
      order: async () => ({ data: [{ ...base, id: "meta-1", provider: "meta" }], error: null }),
      update: () => {
        const updateQuery = { eq: () => updateQuery, select: updateSelect };
        return updateQuery;
      },
    };
    return query;
  });

  render(<IntegrationsPanel />);
  const toggle = await screen.findByRole("switch", { name: "Daily sync for meta" });
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).not.toBeDisabled());
  expect(toggle).toHaveAttribute("aria-checked", "true");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(updateSelect).toHaveBeenCalledWith("id, client_id, ingest_enabled");
});

it("closes the Add Integration form on route change and rejects an old client's stale submit", async () => {
  let selectedClient = "client-1";
  useParams.mockImplementation(() => ({ clientId: selectedClient }));
  from.mockImplementation(() => {
    let readClient = "";
    const query = {
      select: () => query,
      eq: (_field: string, value: string) => { readClient = value; return query; },
      order: async () => ({ data: [{ ...base, id: `meta-${readClient}`, client_id: readClient, provider: "meta" }], error: null }),
    };
    return query;
  });
  rpc.mockResolvedValue({ error: null });

  const rendered = render(<IntegrationsPanel />);
  fireEvent.click(await screen.findByRole("button", { name: "Add" }));
  const aModal = latestAddModal();
  expect(aModal.open).toBe(true);

  selectedClient = "client-2";
  rendered.rerender(<IntegrationsPanel />);
  await screen.findByRole("button", { name: "Add" });
  expect(latestAddModal().open).toBe(false);
  await expect(aModal.onSubmit({ provider: "meta", credential_label: "act_123", secret: "secret-a", access_level: "admin" }))
    .rejects.toThrow("No current-client integration form selected");
  expect(rpc).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(latestAddModal().open).toBe(true);
  await latestAddModal().onSubmit({ provider: "instagram", credential_label: "123", secret: "secret-b", access_level: "admin" });
  expect(rpc).toHaveBeenCalledWith("admin_store_integration_credential", expect.objectContaining({ p_client_id: "client-2", p_provider: "instagram" }));

  selectedClient = "client-1";
  rendered.rerender(<IntegrationsPanel />);
  await screen.findByRole("button", { name: "Add" });
  expect(latestAddModal().open).toBe(false);
  await expect(aModal.onSubmit({ provider: "meta", credential_label: "act_123", secret: "secret-a", access_level: "admin" }))
    .rejects.toThrow("No current-client integration form selected");
  expect(rpc).toHaveBeenCalledTimes(1);
});

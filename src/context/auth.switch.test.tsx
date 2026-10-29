import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FormModal } from "../components/forms/FormModal";
import { RequireRole } from "../components/RequireRole";
import type { FieldDef } from "../components/forms/fields";
import { AuthProvider, useAuth } from "./auth";

const mock = vi.hoisted(() => {
  type Row = { id: string; role: string; full_name: string; email: null; employee_category: null };
  type Result = { data: Row | null; error: null };
  return {
    listener: null as null | ((event: string, session: { user: { id: string } } | null) => void),
    holdB: false,
    resolveB: null as null | ((result: Result) => void),
  };
});

function row(id: string) {
  return { id, role: "admin", full_name: id, email: null, employee_category: null };
}

vi.mock("../lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "user-a" } } } }),
      onAuthStateChange: (listener: typeof mock.listener) => {
        mock.listener = listener;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
      signOut: vi.fn(),
    },
    from: (table: string) => {
      let userId = "";
      const query = {
        select: () => query,
        eq: (_field: string, value: string) => { userId = value; return query; },
        maybeSingle: () => {
          if (table !== "profiles") return Promise.resolve({ data: null, error: null });
          if (userId === "user-b" && mock.holdB) {
            return new Promise((resolve) => { mock.resolveB = resolve; });
          }
          return Promise.resolve({ data: row(userId), error: null });
        },
      };
      return query;
    },
  },
}));

const fields: FieldDef[] = [{ name: "note", label: "Private note", kind: "textarea" }];

function ProtectedForm() {
  const { profile } = useAuth();
  return <>
    <span data-testid="profile-id">{profile?.id}</span>
    <FormModal open onClose={vi.fn()} title="Private form" draftKey="contact:client"
      fields={fields} onSubmit={vi.fn()} />
  </>;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  mock.listener = null;
  mock.holdB = false;
  mock.resolveB = null;
});

describe("authenticated route identity", () => {
  it("unmounts an open private form on a same-route, same-role account switch", async () => {
    render(<AuthProvider><MemoryRouter initialEntries={["/"]}>
      <RequireRole role="admin"><ProtectedForm /></RequireRole>
    </MemoryRouter></AuthProvider>);
    const note = await screen.findByLabelText("Private note");
    expect(screen.getByTestId("profile-id")).toHaveTextContent("user-a");
    fireEvent.change(note, { target: { value: "user-a private value" } });
    expect(note).toHaveValue("user-a private value");

    mock.holdB = true;
    act(() => { mock.listener?.("SIGNED_IN", { user: { id: "user-b" } }); });
    expect(screen.queryByLabelText("Private note")).not.toBeInTheDocument();
    expect(screen.getByText("Loading…")).toBeInTheDocument();

    await act(async () => { mock.resolveB?.({ data: row("user-b"), error: null }); });
    await waitFor(() => expect(screen.getByTestId("profile-id")).toHaveTextContent("user-b"));
    expect(screen.getByLabelText("Private note")).toHaveValue("");
    expect(screen.queryByText("user-a private value")).not.toBeInTheDocument();
  });
});

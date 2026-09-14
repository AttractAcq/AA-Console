import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("../../lib/supabase", () => ({ supabase: { auth: { getSession } } }));

import { GitHubSettingsPanel } from "./GitHubSettingsPanel";

const GRANTED = [
  { permission: "administration", current: "write", required: "write", sufficient: true },
  { permission: "contents", current: "write", required: "write", sufficient: true },
  { permission: "pages", current: "write", required: "write", sufficient: true },
  { permission: "metadata", current: "read", required: "read", sufficient: true },
];

const NONE = GRANTED.map((p) => ({ ...p, current: null, sufficient: false }));

function answer(status: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, ...status }),
    })),
  );
}

const base = {
  configured: true,
  missing: [],
  appId: "4932777",
  installationId: null,
  owner: null,
  targetType: null,
  repositorySelection: null,
  permissions: NONE,
  ready: false,
  verifiedAt: "2026-09-14T18:00:53.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  getSession.mockResolvedValue({ data: { session: { access_token: "t" } } });
  vi.stubEnv("VITE_AGENT_RUNTIME_URL", "https://runtime.example");
});

describe("a key the runtime cannot read", () => {
  // What shipped: "GitHub rejected the connection: error:1E08010C:DECODER
  // routines::unsupported" — naming the one system that was never contacted,
  // for a failure that happened before any request was sent.
  const signing = {
    ...base,
    errorKind: "auth_signing_error",
    error: "GitHub App private key could not be parsed by the runtime.",
  };

  it("does not blame GitHub for a failure GitHub never saw", async () => {
    answer(signing);
    render(<GitHubSettingsPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "GitHub App private key could not be parsed by the runtime.",
    );
    expect(screen.queryByText(/GitHub rejected the connection/i)).not.toBeInTheDocument();
  });

  it("says the failure was local, and what to do about it", async () => {
    answer(signing);
    render(<GitHubSettingsPanel />);
    expect(await screen.findByText(/Nothing was sent to GitHub/i)).toBeInTheDocument();
    // The variable by name — never a value, which the runtime does not send anyway.
    expect(screen.getByText(/GITHUB_APP_PRIVATE_KEY/)).toBeInTheDocument();
  });

  it("names the state as a key problem rather than a generic failure", async () => {
    answer(signing);
    render(<GitHubSettingsPanel />);
    expect(await screen.findByText("Key unreadable")).toBeInTheDocument();
  });
});

describe("GitHub answering no", () => {
  it("reports it as GitHub's refusal, with the status and no remediation for a key", async () => {
    answer({
      ...base,
      errorKind: "github_api_error",
      error: "GitHub rejected the connection request (HTTP 401).",
    });
    render(<GitHubSettingsPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 401");
    expect(screen.getByText("Failing")).toBeInTheDocument();
    expect(screen.queryByText(/Nothing was sent to GitHub/i)).not.toBeInTheDocument();
  });
});

describe("a connection that worked but is short on permissions", () => {
  const short = {
    ...base,
    errorKind: "permission_error",
    error: null,
    owner: "AttractAcq",
    targetType: "Organization",
    repositorySelection: "all",
    installationId: 12345678,
    permissions: GRANTED.map((p) =>
      p.permission === "pages" ? { ...p, current: "read", sufficient: false } : p,
    ),
  };

  it("shows the installation it reached rather than a transport failure", async () => {
    answer(short);
    render(<GitHubSettingsPanel />);
    expect(await screen.findByText("Permissions insufficient")).toBeInTheDocument();
    expect(screen.getByText("AttractAcq")).toBeInTheDocument();
    expect(screen.getByText("12345678")).toBeInTheDocument();
    // Nothing here is an error message; the matrix is the explanation.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the real matrix, naming the one permission that is short", async () => {
    answer(short);
    render(<GitHubSettingsPanel />);
    await screen.findByText("Permissions insufficient");
    expect(screen.getAllByText("OK")).toHaveLength(3);
    expect(screen.getAllByText("Insufficient")).toHaveLength(1);
    expect(screen.getByText(/accept the update on the installation/i)).toBeInTheDocument();
  });
});

describe("nothing configured", () => {
  it("names the absent variables and nothing else", async () => {
    answer({
      ...base,
      configured: false,
      missing: ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY"],
      appId: null,
      errorKind: "configuration_error",
      error: null,
    });
    render(<GitHubSettingsPanel />);
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText(/Missing: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY/)).toBeInTheDocument();
  });
});

describe("a runtime that has not shipped the classification yet", () => {
  // The console and the runtime deploy separately. Reading an absent errorKind
  // as "no problem" would show a broken connection as Connected.
  it("still refuses to call an old runtime's failure a success", async () => {
    answer({ ...base, error: "GitHub rejected the connection request (HTTP 401)." });
    render(<GitHubSettingsPanel />);
    expect(await screen.findByText("Failing")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it("still calls an old runtime's permission shortfall a permission problem", async () => {
    answer({ ...base, owner: "AttractAcq", permissions: NONE, ready: false });
    render(<GitHubSettingsPanel />);
    expect(await screen.findByText("Permissions insufficient")).toBeInTheDocument();
  });
});

describe("a healthy connection", () => {
  it("is the only case that reads as connected", async () => {
    answer({
      ...base,
      errorKind: null,
      error: null,
      owner: "AttractAcq",
      targetType: "Organization",
      repositorySelection: "all",
      installationId: 12345678,
      permissions: GRANTED,
      ready: true,
    });
    render(<GitHubSettingsPanel />);
    await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
    expect(screen.getAllByText("OK")).toHaveLength(4);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

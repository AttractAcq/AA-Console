import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchProofAssets, signPaths, useParams } = vi.hoisted(() => ({
  fetchProofAssets: vi.fn(),
  signPaths: vi.fn(),
  useParams: vi.fn(),
}));

vi.mock("../../lib/media", async () => {
  const actual = await vi.importActual<typeof import("../../lib/media")>("../../lib/media");
  return { ...actual, fetchProofAssets, signPaths };
});
vi.mock("react-router-dom", () => ({ useParams }));
vi.mock("../../lib/supabase", () => ({ supabase: { from: () => ({}) } }));

import { ProofBankPanel } from "./ProofBankPanel";
import type { ProofAsset } from "../../lib/media";

const proof = (over: Partial<ProofAsset> = {}): ProofAsset => ({
  id: crypto.randomUUID(),
  client_id: "client-1",
  media_type: "text",
  title: "Implant patient",
  body: "Zero pain, done in one visit",
  storage_path: null,
  source: "Google review",
  created_at: "2026-03-01T00:00:00Z",
  ref_number: "HD-0019",
  proof_type: "review",
  claim: "Four implants in one visit",
  evidence: "Named review",
  avatar_relevance: "Full-arch patients",
  services: "Implants",
  strength: "high",
  usage_rights: "approved",
  captured_on: "2026-03-01",
  expires_on: null,
  ...over,
});

function show(rows: ProofAsset[]) {
  fetchProofAssets.mockResolvedValue(rows);
  signPaths.mockResolvedValue(new Map());
  return render(<ProofBankPanel />);
}

beforeEach(() => {
  vi.clearAllMocks();
  useParams.mockReturnValue({ clientId: "client-1" });
});

describe("what the Proof Bank leads with", () => {
  // The count that matters is not how much proof exists but how much an agent
  // may actually cite, and the gap between them is a job someone can do.
  it("says how much is cleared, not just how much exists", async () => {
    show([proof(), proof({ usage_rights: "not_cleared" }), proof({ usage_rights: "restricted" })]);
    expect(await screen.findByText(/1 of 3 cleared for use/)).toBeInTheDocument();
  });

  it("explains the consequence of not clearing, in the agent's terms", async () => {
    show([proof({ usage_rights: "not_cleared" })]);
    expect(
      await screen.findByText(/a brief will correctly say there is no proof to cite/i),
    ).toBeInTheDocument();
  });

  it("says so plainly when everything is cleared", async () => {
    show([proof(), proof()]);
    expect(await screen.findByText(/All 2 cleared for use/)).toBeInTheDocument();
  });

  // A record with no claim cannot be matched to a buyer, which is a different
  // problem from not being cleared and needs saying separately.
  it("counts records that have no claim recorded", async () => {
    show([proof(), proof({ claim: null })]);
    expect(await screen.findByText(/1 has no claim recorded/)).toBeInTheDocument();
  });

  it("gets the grammar right for several unstructured records", async () => {
    show([proof({ claim: null }), proof({ claim: null })]);
    expect(await screen.findByText(/2 have no claim recorded/)).toBeInTheDocument();
  });

  it("shows no banner at all when there is no proof yet", async () => {
    show([]);
    await screen.findByText(/No .* proof yet/i);
    expect(screen.queryByText(/cleared for use/)).not.toBeInTheDocument();
  });
});

describe("what each record shows at a glance", () => {
  it("leads a cleared record with its reference and strength", async () => {
    show([proof()]);
    expect(await screen.findByText(/HD-0019 · cleared · high/)).toBeInTheDocument();
  });

  it("marks an uncleared record as such rather than showing a strength", async () => {
    show([proof({ usage_rights: "not_cleared" })]);
    expect(await screen.findByText(/not cleared/)).toBeInTheDocument();
    expect(screen.queryByText(/cleared · high/)).not.toBeInTheDocument();
  });

  // The claim is what a person needs to judge it; the filed body is the raw
  // material behind it.
  it("shows the claim in preference to the filed body", async () => {
    show([proof()]);
    expect(await screen.findByText("Four implants in one visit")).toBeInTheDocument();
    expect(screen.queryByText("Zero pain, done in one visit")).not.toBeInTheDocument();
  });

  it("falls back to the filed body when no claim exists yet", async () => {
    show([proof({ claim: null })]);
    expect(await screen.findByText("Zero pain, done in one visit")).toBeInTheDocument();
  });
});

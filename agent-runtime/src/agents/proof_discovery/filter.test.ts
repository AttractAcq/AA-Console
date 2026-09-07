import { describe, expect, it } from "vitest";
import { isUsableFind, isDuplicate, toProofRows, type Found } from "./index.js";

const find = (over: Partial<Found> = {}): Found => ({
  title: "Google reviews",
  proof_type: "review",
  claim: "4.9 from 212 reviews",
  evidence: "Google Business Profile shows 4.9 across 212 reviews",
  source: "https://maps.google.com/xyz",
  strength: "high",
  avatar_relevance: "",
  services: "",
  ...over,
});

describe("what may be filed as proof", () => {
  it("accepts a find with a claim and a real URL", () => {
    expect(isUsableFind(find())).toBe(true);
  });

  // A claim with no URL looks like evidence and cannot be checked, which is
  // worse than having nothing.
  it("discards a find with no source", () => {
    expect(isUsableFind(find({ source: "" }))).toBe(false);
    expect(isUsableFind(find({ source: undefined }))).toBe(false);
  });

  it("discards a source that is not a URL", () => {
    expect(isUsableFind(find({ source: "Google" }))).toBe(false);
    expect(isUsableFind(find({ source: "maps.google.com/xyz" }))).toBe(false);
  });

  it("accepts http as well as https", () => {
    expect(isUsableFind(find({ source: "http://example.com/a" }))).toBe(true);
  });

  it("discards a find with no claim, however good the URL", () => {
    expect(isUsableFind(find({ claim: "" }))).toBe(false);
  });
});

describe("not filing the same proof twice", () => {
  const existing = [
    { source: "https://maps.google.com/xyz", claim: "4.9 from 212 reviews" },
    { source: null, claim: "Featured in the Mercury" },
  ];

  it("recognises the same source", () => {
    expect(isDuplicate(find(), existing)).toBe(true);
  });

  it("ignores a trailing slash and case when comparing sources", () => {
    expect(isDuplicate(find({ source: "https://MAPS.google.com/xyz/" , claim: "different" }), existing)).toBe(true);
  });

  it("recognises the same claim even from a different URL", () => {
    expect(isDuplicate(find({ source: "https://elsewhere.com/a" }), existing)).toBe(true);
  });

  it("recognises a claim already on file that has no source", () => {
    expect(
      isDuplicate(find({ source: "https://new.example/a", claim: "Featured in the Mercury" }), existing),
    ).toBe(true);
  });

  it("lets a genuinely new find through", () => {
    expect(isDuplicate(find({ source: "https://trustpilot.com/a", claim: "4.6 from 40" }), existing)).toBe(false);
  });

  // Two records that both happen to have no source must not collapse into
  // each other just because both are empty.
  it("does not treat two empty sources as a match", () => {
    expect(isDuplicate(find({ source: "", claim: "brand new" }), existing)).toBe(false);
  });

  it("files against an empty bank", () => {
    expect(isDuplicate(find(), [])).toBe(false);
  });
});

describe("the rows that actually get filed", () => {
  const bank = [{ source: "https://maps.google.com/xyz", claim: "4.9 from 212 reviews" }];

  // The single most important property in this agent. Finding a review is not
  // permission to advertise with it, and this agent cannot know whether a
  // customer agreed to be quoted.
  it("never clears anything it found, whatever the model said", () => {
    const rows = toProofRows(
      [find({ source: "https://new.example/a", claim: "new" })],
      [],
      "client-1",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.usage_rights).toBe("not_cleared");
  });

  it("clears nothing even across a batch of strong finds", () => {
    const rows = toProofRows(
      [
        find({ source: "https://a.example/1", claim: "a", strength: "high" }),
        find({ source: "https://b.example/2", claim: "b", strength: "high" }),
      ],
      [],
      "client-1",
    );
    expect(rows.every((r) => r.usage_rights === "not_cleared")).toBe(true);
  });

  // Without this the bank fills with the same Google listing on every run.
  it("drops finds already on file", () => {
    const rows = toProofRows(
      [find(), find({ source: "https://new.example/a", claim: "genuinely new" })],
      bank,
      "client-1",
    );
    expect(rows.map((r) => r.claim)).toEqual(["genuinely new"]);
  });

  it("drops finds with no source before they reach the bank", () => {
    expect(toProofRows([find({ source: "" })], [], "client-1")).toHaveLength(0);
  });

  it("carries the structure through so the record is queryable", () => {
    const [row] = toProofRows(
      [find({ source: "https://x.example/1", claim: "c", avatar_relevance: "Owners", services: "Implants" })],
      [],
      "client-1",
    );
    expect(row).toMatchObject({
      client_id: "client-1",
      proof_type: "review",
      strength: "high",
      avatar_relevance: "Owners",
      services: "Implants",
    });
    expect(row?.source).toBe("https://x.example/1");
  });

  // A model can emit a value outside the enum; the database has a check
  // constraint and a violation would fail the whole insert.
  it("falls back rather than storing a type or strength the database would reject", () => {
    const [row] = toProofRows(
      [find({ source: "https://y.example/1", claim: "c", proof_type: "podcast", strength: "enormous" })],
      [],
      "client-1",
    );
    expect(row?.proof_type).toBeNull();
    expect(row?.strength).toBe("medium");
  });

  it("names a record after its claim when the model gave no title", () => {
    const [row] = toProofRows(
      [find({ source: "https://z.example/1", claim: "Registered with the HPCSA", title: "" })],
      [],
      "client-1",
    );
    expect(row?.title).toBe("Registered with the HPCSA");
  });
});

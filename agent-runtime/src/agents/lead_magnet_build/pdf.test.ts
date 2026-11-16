import { describe, expect, it } from "vitest";
import { renderGuidePdf } from "./pdf.js";

describe("campaign guide PDF", () => {
  it("renders a multi-page file with intact cross-reference offsets", () => {
    const pdf = renderGuidePdf({ title: "A practical guide", intro: "Start with the buyer's question.",
      sections: [{ title: "First step", body: "The next useful action. ".repeat(650) },
        { title: "Second step", body: "Follow up and review the result." }],
      closing: "Discuss the next step with the team." });
    const text = pdf.toString("ascii");
    expect(text.startsWith("%PDF-1.4\n")).toBe(true);
    expect(text.endsWith("%%EOF\n")).toBe(true);
    const xref = Number(text.match(/startxref\n(\d+)\n%%EOF\n$/)?.[1]);
    expect(text.slice(xref, xref + 5)).toBe("xref\n");
    const count = Number(text.match(/\/Count (\d+)/)?.[1]);
    expect(count).toBeGreaterThan(1);
    for (const [, offset] of text.matchAll(/^(\d{10}) 00000 n $/gm)) {
      expect(text.slice(Number(offset))).toMatch(/^\d+ 0 obj\n/);
    }
  });

  it("refuses copy that would be silently corrupted", () => {
    expect(() => renderGuidePdf({ title: "Guide 🎯", intro: "Intro", sections: [],
      closing: "Close" })).toThrow(/cannot preserve/);
  });
});

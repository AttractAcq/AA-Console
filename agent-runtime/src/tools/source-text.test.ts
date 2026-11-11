import { describe, expect, it } from "vitest";
import { inspectedFetchedSource, pdfText, sourceText } from "./source-text.js";
import type Anthropic from "@anthropic-ai/sdk";

function smallPdf(): string {
  const stream = "BT /F1 12 Tf 72 720 Td (Additions declined by 15.5 percent.) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf).toString("base64");
}

describe("fetched source text", () => {
  it("extracts inspectable text from a fetched PDF", async () => {
    expect(await pdfText(smallPdf())).toContain("Additions declined by 15.5 percent.");
  });

  it("rejects a bot challenge instead of treating it as source material", () => {
    expect(sourceText('<META NAME="robots" CONTENT="noindex,nofollow"><script src="/_Incapsula_Resource">')).toBeNull();
    expect(sourceText("Official table: 15.5 percent.")).toBe("Official table: 15.5 percent.");
  });

  it("retains inspectable source text from a provider fetch result", async () => {
    const block = {
      type: "web_fetch_tool_result",
      caller: { type: "direct" },
      tool_use_id: "fetch-1",
      content: {
        type: "web_fetch_result",
        url: "https://example.gov/primary",
        retrieved_at: "2026-11-10T00:00:00Z",
        content: {
          type: "document", title: "Primary source", citations: null,
          source: { type: "text", media_type: "text/plain", data: "Official total: 15.5 percent." },
        },
      },
    } as Anthropic.Messages.WebFetchToolResultBlock;
    expect(await inspectedFetchedSource(block)).toEqual({
      url: "https://example.gov/primary",
      retrievedAt: "2026-11-10T00:00:00Z",
      text: "Official total: 15.5 percent.",
    });
  });
});

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type Anthropic from "@anthropic-ai/sdk";

export interface FetchedSource {
  url: string;
  text: string;
  retrievedAt: string | null;
}

const MAX_PDF_BYTES = 12 * 1024 * 1024;
const MAX_PAGES = 80;
const MAX_TEXT = 240_000;

export async function pdfText(base64: string): Promise<string | null> {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_PDF_BYTES || bytes.subarray(0, 5).toString() !== "%PDF-") return null;
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  try {
    const document = await task.promise;
    if (document.numPages > MAX_PAGES) return null;
    const pages: string[] = [];
    for (let pageNo = 1; pageNo <= document.numPages; pageNo += 1) {
      const page = await document.getPage(pageNo);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
      page.cleanup();
      if (pages.join("\n").length > MAX_TEXT) return null;
    }
    return pages.join("\n");
  } catch {
    return null;
  } finally {
    await task.destroy();
  }
}

export function sourceText(text: string): string | null {
  if (!text || text.length > MAX_TEXT || /_Incapsula_Resource|robots[^\n]*noindex,nofollow/i.test(text)) return null;
  return text;
}

export async function inspectedFetchedSource(
  block: Anthropic.Messages.WebFetchToolResultBlock,
): Promise<FetchedSource | null> {
  if (block.content.type !== "web_fetch_result") return null;
  const fetched = block.content;
  const source = fetched.content.source;
  const text = source.type === "text" ? sourceText(source.data) : await pdfText(source.data);
  return text ? { url: fetched.url, text, retrievedAt: fetched.retrieved_at } : null;
}

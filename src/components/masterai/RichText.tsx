import type { ReactNode } from "react";

/**
 * A deliberately small renderer for the subset of markdown the Master AI
 * actually produces: bold, inline code, bullets, headings and tables.
 *
 * A markdown dependency would be the obvious move, but this project runs on
 * six runtime dependencies and the model's output is narrow and known. If
 * it ever needs images, links or nested lists, swap this for a real parser
 * rather than growing it.
 */

function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Bold and inline code, in one pass so they cannot nest incorrectly.
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let i = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    i += 1;
    if (token.startsWith("**")) {
      nodes.push(
        <strong key={`${keyPrefix}-b${i}`} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(
        <code key={`${keyPrefix}-c${i}`} className="rounded bg-foreground/10 px-1 py-0.5 text-[0.85em]">
          {token.slice(1, -1)}
        </code>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

const isTableRow = (line: string) => line.trim().startsWith("|") && line.trim().endsWith("|");
const isDivider = (line: string) => /^\|[\s:|-]+\|$/.test(line.trim());
const cells = (line: string) =>
  line.trim().slice(1, -1).split("|").map((c) => c.trim());

export function RichText({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Table: a header row, an optional divider, then body rows.
    if (isTableRow(line) && i + 1 < lines.length && isDivider(lines[i + 1] ?? "")) {
      const header = cells(line);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        body.push(cells(lines[i] ?? ""));
        i += 1;
      }
      blocks.push(
        <div key={`t${i}`} className="-mx-1 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border">
                {header.map((h, x) => (
                  <th key={x} className="px-1.5 py-1 text-left font-semibold">
                    {inline(h, `th${i}-${x}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, y) => (
                <tr key={y} className="border-b border-border/50 last:border-0">
                  {row.map((c, x) => (
                    <td key={x} className="px-1.5 py-1 align-top">
                      {inline(c, `td${i}-${y}-${x}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // Bullets
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      blocks.push(
        <ul key={`u${i}`} className="ml-4 list-disc space-y-0.5">
          {items.map((item, x) => (
            <li key={x}>{inline(item, `li${i}-${x}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Headings render as emphasis rather than page-level headings, so they
    // never compete with the real headings around the chat.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <p key={`h${i}`} className="font-semibold">
          {inline(heading[2] ?? "", `h${i}`)}
        </p>,
      );
      i += 1;
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const para: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !isTableRow(lines[i] ?? "") &&
      !/^\s*[-*]\s+/.test(lines[i] ?? "") &&
      !/^#{1,6}\s+/.test(lines[i] ?? "")
    ) {
      para.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push(<p key={`p${i}`}>{inline(para.join("\n"), `p${i}`)}</p>);
  }

  return <div className="space-y-2 whitespace-pre-wrap">{blocks}</div>;
}

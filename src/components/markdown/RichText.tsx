import type { ReactNode } from "react";
import { parseInline } from "./markdown";

/**
 * A small markdown renderer for the subset the Master AI actually produces.
 *
 * A markdown dependency would be the obvious move, but this project runs on
 * six runtime dependencies and the model's output is narrow and known.
 *
 * Two deliberate departures from markdown:
 *
 *  - `_` never means italic. Underscores are everywhere in this domain —
 *    agent_key, client_id, scheduled_posts — and treating them as emphasis
 *    mangles almost every identifier the assistant mentions.
 *  - Anything unmatched falls through as literal text rather than being
 *    dropped, so a stray marker is visible instead of silently eating the
 *    rest of the line.
 */

const isTableRow = (line: string) => line.trim().startsWith("|") && line.trim().endsWith("|");
const isDivider = (line: string) => /^\|[\s:|-]+\|$/.test(line.trim());
const cells = (line: string) => line.trim().slice(1, -1).split("|").map((c) => c.trim());
const BULLET = /^\s*[-*+]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

export function RichText({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let n = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    n += 1;

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // Fenced code
    if (line.trim().startsWith("```")) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith("```")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // closing fence
      blocks.push(
        <pre
          key={`f${n}`}
          className="overflow-x-auto rounded-md bg-foreground/10 p-2 text-xs leading-relaxed"
        >
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push(<hr key={`r${n}`} className="border-border" />);
      i += 1;
      continue;
    }

    // Table
    if (isTableRow(line) && isDivider(lines[i + 1] ?? "")) {
      const header = cells(line);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i] ?? "")) {
        body.push(cells(lines[i] ?? ""));
        i += 1;
      }
      blocks.push(
        <div key={`t${n}`} className="-mx-1 overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border">
                {header.map((h, x) => (
                  <th key={x} className="px-1.5 py-1 text-left font-semibold">
                    {parseInline(h, `th${n}${x}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, y) => (
                <tr key={y} className="border-b border-border/50 last:border-0">
                  {row.map((c, x) => (
                    <td key={x} className="px-1.5 py-1 align-top">
                      {parseInline(c, `td${n}${y}${x}`)}
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

    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        body.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push(
        <blockquote key={`q${n}`} className="border-l-2 border-border pl-3 text-muted-foreground">
          {parseInline(body.join("\n"), `q${n}`)}
        </blockquote>,
      );
      continue;
    }

    // Lists, bulleted or numbered
    const listType = BULLET.test(line) ? BULLET : NUMBERED.test(line) ? NUMBERED : null;
    if (listType) {
      const items: string[] = [];
      while (i < lines.length && listType.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(listType, ""));
        i += 1;
      }
      const ordered = listType === NUMBERED;
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={`l${n}`} className={`ml-4 space-y-0.5 ${ordered ? "list-decimal" : "list-disc"}`}>
          {items.map((item, x) => (
            <li key={x}>{parseInline(item, `li${n}${x}`)}</li>
          ))}
        </Tag>,
      );
      continue;
    }

    // Headings render as emphasis, never as page-level headings — they must
    // not compete with the real headings around the chat.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <p key={`h${n}`} className="font-semibold">
          {parseInline(heading[2] ?? "", `h${n}`)}
        </p>,
      );
      i += 1;
      continue;
    }

    // Paragraph, up to the next blank line or block start
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? "";
      if (
        l.trim() === "" ||
        isTableRow(l) ||
        BULLET.test(l) ||
        NUMBERED.test(l) ||
        /^#{1,6}\s+/.test(l) ||
        /^\s*>\s?/.test(l) ||
        l.trim().startsWith("```")
      ) {
        break;
      }
      para.push(l);
      i += 1;
    }
    blocks.push(<p key={`p${n}`}>{parseInline(para.join("\n"), `p${n}`)}</p>);
  }

  return <div className="space-y-2">{blocks}</div>;
}


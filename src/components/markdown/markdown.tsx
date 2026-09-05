import type { ReactNode } from "react";

/**
 * Inline markdown parsing, split out of RichText so that file exports only
 * a component and fast refresh keeps working.
 */

/** http(s) only: model output can quote a URL that came out of the database. */
function safeHref(href: string): string | null {
  try {
    const url = new URL(href, "https://example.invalid");
    return url.protocol === "http:" || url.protocol === "https:" ? href : null;
  } catch {
    return null;
  }
}

/**
 * Recursive so nesting works — bold wrapping inline code is the common one,
 * and a non-recursive pass renders its backticks literally.
 */
export function parseInline(text: string, k: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = "";
  let i = 0;
  let n = 0;

  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };

  while (i < text.length) {
    // Inline code is terminal: nothing inside it is markup.
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        n += 1;
        out.push(
          <code key={`${k}c${n}`} className="rounded bg-foreground/10 px-1 py-0.5 text-[0.85em]">
            {text.slice(i + 1, end)}
          </code>,
        );
        i = end + 1;
        continue;
      }
    }

    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 1) {
        flush();
        n += 1;
        out.push(
          <strong key={`${k}b${n}`} className="font-semibold">
            {parseInline(text.slice(i + 2, end), `${k}b${n}`)}
          </strong>,
        );
        i = end + 2;
        continue;
      }
    }

    // Single-asterisk italic, but only when it hugs the words it wraps —
    // otherwise a lone * in prose starts a run that never ends.
    if (text[i] === "*" && !text.startsWith("**", i)) {
      const end = text.indexOf("*", i + 1);
      const opensTight = !/\s/.test(text[i + 1] ?? " ");
      const closesTight = end > i + 1 && !/\s/.test(text[end - 1] ?? " ");
      if (end > i + 1 && opensTight && closesTight) {
        flush();
        n += 1;
        out.push(
          <em key={`${k}i${n}`}>{parseInline(text.slice(i + 1, end), `${k}i${n}`)}</em>,
        );
        i = end + 1;
        continue;
      }
    }

    if (text[i] === "[") {
      const close = text.indexOf("]", i);
      if (close > i && text[close + 1] === "(") {
        const paren = text.indexOf(")", close + 2);
        if (paren > close) {
          const href = safeHref(text.slice(close + 2, paren));
          if (href) {
            flush();
            n += 1;
            out.push(
              <a
                key={`${k}l${n}`}
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-brand-strong underline"
              >
                {parseInline(text.slice(i + 1, close), `${k}l${n}`)}
              </a>,
            );
            i = paren + 1;
            continue;
          }
        }
      }
    }

    buf += text[i];
    i += 1;
  }

  flush();
  return out;
}

/** Exported for tests: the plain text a rendered tree would show. */
export function renderToPlainText(text: string): string {
  const strip = (nodes: ReactNode[]): string =>
    nodes
      .map((node) => {
        if (typeof node === "string") return node;
        if (node && typeof node === "object" && "props" in node) {
          const children = (node as { props: { children?: ReactNode } }).props.children;
          return strip(Array.isArray(children) ? children : [children]);
        }
        return "";
      })
      .join("");
  return strip(parseInline(text, "t"));
}

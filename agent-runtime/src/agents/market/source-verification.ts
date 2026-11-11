import type { FetchedSource } from "../../tools/source-text.js";

function normalizedText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function sourceKey(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    url.hash = "";
    url.searchParams.sort();
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function sectionPart(body: string, label: string, nextLabel: string): string | null {
  const start = body.toLowerCase().indexOf(label.toLowerCase());
  const end = body.toLowerCase().indexOf(nextLabel.toLowerCase(), start + label.length);
  return start < 0 || end < 0 ? null : body.slice(start + label.length, end)
    .replace(/^\*{0,2}\s*[:—–-]\*{0,2}\s*/, "").trim();
}

function answerPart(body: string): string {
  const start = body.toLowerCase().lastIndexOf("answer");
  return start < 0 ? "" : body.slice(start + 6).replace(/^\s*[:—–-]\s*/, "").trim();
}

const FIGURE = /(?:[−-]?\d[\d,. ]*\s*%|(?:R|USD|\$|€|£)\s*\d[\d,. ]*|\b\d[\d,. ]*\s*(?:million|billion|thousand|businesses|firms|people|plans|jobs|units|square metres|m²)\b)/i;
const MARKET_SCALE_FIGURE = /(?:\b\d[\d,. ]*\s*(?:million|billion|thousand|businesses|firms|people|plans|jobs|square metres|m²)\b|(?:R|USD|\$|€|£)\s*\d[\d,. ]*\s*(?:million|billion|thousand))/i;

/** A linked URL is a candidate. Only a fetched primary document with an exact quote is evidence. */
export function verifyMarketSourceClaims(
  sections: Record<string, string>, fetchedSources: FetchedSource[],
): string | null {
  const fetched = new Map(fetchedSources.map((source) => [sourceKey(source.url), source]));
  const quotesBySection = new Map<string, string[]>();

  for (const [key, body] of Object.entries(sections)) {
    const evidence = sectionPart(body, "External evidence", "Evidence limit");
    if (evidence === null) return `${key} needs External evidence before Evidence limit.`;
    if (/^none verified\.?$/i.test(evidence)) {
      quotesBySection.set(key, []);
      continue;
    }

    const lines = evidence.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0 || lines.length % 3 !== 0) {
      return `${key} needs Source, Quote and Scope lines for every external claim.`;
    }
    const sectionQuotes: string[] = [];
    for (let i = 0; i < lines.length; i += 3) {
      const url = (lines[i] ?? "").match(/^(?:[-*]\s*)?\*{0,2}Source:\*{0,2}\s*(https:\/\/\S+)$/i)?.[1];
      const quote = (lines[i + 1] ?? "").match(/^(?:[-*]\s*)?\*{0,2}Quote:\*{0,2}\s*["“](.+)["”]$/i)?.[1];
      const scope = (lines[i + 2] ?? "").match(/^(?:[-*]\s*)?\*{0,2}Scope:\*{0,2}\s*(.+)$/i)?.[1];
      if (!url || !quote || !scope || quote.length < 24) {
        return `${key} needs Source URL, exact Quote and Scope lines in that order.`;
      }
      const source = fetched.get(sourceKey(url));
      if (!source) return `${key} cites a source the runtime could not fetch and inspect: ${url}`;
      if (!normalizedText(source.text).includes(normalizedText(quote))) {
        return `${key} quotes text that does not match the fetched primary source: ${url}`;
      }
      // A PDF table row without its column headers is exact text but does not
      // establish which number is the rate, period or unit.
      const numbers = quote.match(/[−-]?\d[\d,.]*/g) ?? [];
      const words = quote.match(/\b[A-Za-z]{3,}\b/g) ?? [];
      if (numbers.length >= 4 && words.length < 10) {
        return `${key} quotes an unlabelled numeric table row; use a self-contained source sentence instead.`;
      }
      sectionQuotes.push(quote);
      if (FIGURE.test(scope)) return `${key} has an external figure in Scope outside the matched quote.`;
    }
    quotesBySection.set(key, sectionQuotes);
  }

  const outsideQuotes: string[] = [];
  for (const [key, body] of Object.entries(sections)) {
    const sectionQuotes = quotesBySection.get(key) ?? [];
    const quotedPercentages = sectionQuotes.flatMap((quote) => quote.match(/[−-]?\d[\d,. ]*\s*%/g) ?? []);
    const sectionProse = body.replace(/https?:\/\/\S+/g, "")
      .replace(/["“][^"”]+["”]/g, (quoted) => sectionQuotes.some((quote) =>
        quoted.includes(quote)) ? "" : quoted);
    outsideQuotes.push(sectionProse);
    const unquotedPercentages = sectionProse.match(/[−-]?\d[\d,. ]*\s*%/g) ?? [];
    if (unquotedPercentages.some((value) => !quotedPercentages.some((quoted) =>
      normalizedText(quoted) === normalizedText(value)))) {
      return `${key} includes a percentage outside its own matched primary-source quote.`;
    }
  }
  if (MARKET_SCALE_FIGURE.test(outsideQuotes.join("\n"))) {
    return "Market includes a scale or buyer-count figure outside a matched primary-source quote.";
  }

  for (const key of ["market-size-and-share", "market-direction"]) {
    const body = sections[key] ?? "";
    const answer = answerPart(body);
    const quoteNumbers = (quotesBySection.get(key) ?? []).flatMap((quote) =>
      quote.match(/[−-]?\d[\d,. ]*\s*%/g) ?? []);
    const percentages = answer.match(/[−-]?\d[\d,. ]*\s*%/g) ?? [];
    if (percentages.some((value) => !quoteNumbers.some((quoted) => normalizedText(quoted) === normalizedText(value)))) {
      return `${key} uses a percentage outside a matched primary-source quote.`;
    }
    if (key === "market-direction" && FIGURE.test(answer)
      && !quotesBySection.get(key)?.some((quote) => normalizedText(quote).includes(normalizedText(answer.match(FIGURE)?.[0] ?? "")))) {
      return "Market direction uses a figure outside its matched source quote.";
    }
    if ((quotesBySection.get(key) ?? []).length === 0
      && !/\b(?:unknown|undetermined|not established)\b/i.test(answer)) {
      return `${key} needs to remain unknown without matched primary-source facts.`;
    }
  }
  return null;
}

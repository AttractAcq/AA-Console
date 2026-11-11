import { describe, expect, it } from "vitest";
import { verifyMarketSourceClaims } from "./source-verification.js";

const url = "https://example.gov/statistics/january-2026";
const source = {
  url,
  retrievedAt: "2026-11-10T00:00:00Z",
  text: "Building plans passed at current prices. Additions and alterations decreased by 15,5% in January 2026 compared with January 2025. Residential buildings decreased by 1,1%. A different province contributed -3,2%.",
};
const unknown = "Context: supplied.\nExternal evidence: none verified\nEvidence limit: no external measure used.\nUnknown: target demand.\nAnswer: undetermined.";

function section(quote: string, answer = "Target-trade direction remains unknown."): string {
  return `Context: supplied.\nExternal evidence:\nSource: ${url}\nQuote: "${quote}"\nScope: South Africa; January 2026 versus January 2025; percent.\nEvidence limit: building plans are approvals, not target-trade demand.\nUnknown: target demand.\nAnswer: ${answer}`;
}

describe("Market primary-source fact verification", () => {
  it("matches a full quote against fetched text before saving", () => {
    const quote = "Additions and alterations decreased by 15,5% in January 2026 compared with January 2025.";
    expect(verifyMarketSourceClaims({ "market-size-and-share": unknown, "market-direction": section(quote) }, [source])).toBeNull();
    expect(verifyMarketSourceClaims({
      "market-size-and-share": unknown,
      "market-direction": section(quote)
        .replace("External evidence:", "**External evidence:**")
        .replace("Source:", "**Source:**")
        .replace("Quote:", "**Quote:**")
        .replace("Scope:", "**Scope:**"),
    }, [source])).toBeNull();
  });

  it("rejects the wrong percentage even when the official URL is linked", () => {
    const falseQuote = "Additions and alterations decreased by -3,2% in January 2026 compared with January 2025.";
    expect(verifyMarketSourceClaims({ "market-size-and-share": unknown, "market-direction": section(falseQuote) }, [source]))
      .toMatch(/does not match the fetched primary source/);
  });

  it("fails closed when fetch is unavailable or the answer adds an unquoted percentage", () => {
    const quote = "Additions and alterations decreased by 15,5% in January 2026 compared with January 2025.";
    expect(verifyMarketSourceClaims({ "market-size-and-share": unknown, "market-direction": section(quote) }, []))
      .toMatch(/could not fetch and inspect/);
    expect(verifyMarketSourceClaims({ "market-size-and-share": unknown, "market-direction": section(quote, "The target trades fell 3,2%.") }, [source]))
      .toMatch(/outside its own matched primary-source quote/);
    expect(verifyMarketSourceClaims({
      "market-size-and-share": unknown.replace("Unknown: target demand", "Unknown: whether a 3,2% decrease applies"),
      "market-direction": unknown,
    }, [])).toMatch(/percentage outside its own matched primary-source quote/);
    expect(verifyMarketSourceClaims({
      "market-size-and-share": unknown.replace("Answer: undetermined", "Answer: share unknown, with 50,000 businesses reachable."),
      "market-direction": unknown,
    }, [])).toMatch(/buyer-count figure outside a matched primary-source quote/);
  });

  it("does not borrow a percentage quote from another section", () => {
    const quote = "Additions and alterations decreased by 15,5% in January 2026 compared with January 2025.";
    expect(verifyMarketSourceClaims({
      "market-size-and-share": unknown.replace("Unknown: target demand", "Unknown: whether the trade fell 15,5%"),
      "market-direction": section(quote),
    }, [source])).toMatch(/market-size-and-share includes a percentage outside its own matched primary-source quote/);
  });

  it("rejects a percentage inferred from a PDF table row that omits the percent sign", () => {
    const row = "Additions and alterations 4 377 280 3 935 297 -441 983 -10,1";
    const pdf = { ...source, text: row };
    expect(verifyMarketSourceClaims({
      "market-size-and-share": unknown,
      "market-direction": section(row, "The category fell 10,1%.")
    }, [pdf])).toMatch(/unlabelled numeric table row/);
  });

  it("does not read the end of larger as a rand amount in source scope", () => {
    const quote = "Additions and alterations decreased by 15,5% in January 2026 compared with January 2025.";
    const scoped = section(quote).replace(
      "Scope: South Africa; January 2026 versus January 2025; percent.",
      "Scope: South Africa, larger municipalities; Jan–Feb 2026 versus Jan–Feb 2025; R'000, building plans passed; % change.",
    );
    expect(verifyMarketSourceClaims({ "market-size-and-share": unknown, "market-direction": scoped }, [source])).toBeNull();
  });

  it("allows honest unknowns without a fetched source", () => {
    expect(verifyMarketSourceClaims({ "market-size-and-share": unknown, "market-direction": unknown }, [])).toBeNull();
    expect(verifyMarketSourceClaims({ "market-size-and-share": unknown, "market-direction": unknown.replace("undetermined", "growing") }, []))
      .toMatch(/remain unknown/);
  });
});

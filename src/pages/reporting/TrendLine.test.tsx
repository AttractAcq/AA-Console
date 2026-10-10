import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TrendLine } from "./TrendLine";
import { comparePaid, type Comparison } from "../../lib/metricsCompare";

const paid = (over: Partial<Parameters<typeof comparePaid>[0]> = {}) => ({
  spend: 1000,
  impressions: 50000,
  clicks: 400,
  conversions: 40,
  days_covered: 30,
  currency: "ZAR",
  ...over,
});

describe("how a figure moved", () => {
  it("says up with the absolute move and the percentage", () => {
    const c = comparePaid(paid(), paid({ clicks: 300 }));
    render(<TrendLine comparison={c} label="Clicks" />);
    expect(screen.getByText(/Up 100 \(\+33.3%\)/)).toBeInTheDocument();
    expect(screen.getByText(/on 300 before/)).toBeInTheDocument();
  });

  it("says down rather than a negative rise", () => {
    const c = comparePaid(paid(), paid({ clicks: 500 }));
    render(<TrendLine comparison={c} label="Clicks" />);
    expect(screen.getByText(/Down 100 \(-20%\)/)).toBeInTheDocument();
  });

  it("says flat rather than up nothing", () => {
    const c = comparePaid(paid(), paid());
    render(<TrendLine comparison={c} label="Clicks" />);
    expect(screen.getByText(/Flat/)).toBeInTheDocument();
  });

  it("withholds a percentage off a tiny base, and says why", () => {
    // One click becoming three is +200%, and a reader who repeats that has
    // been misled by a green arrow.
    const c = comparePaid(paid({ clicks: 3 }), paid({ clicks: 1 }));
    render(<TrendLine comparison={c} label="Clicks" />);
    expect(screen.getByText(/Up 2/)).toBeInTheDocument();
    expect(screen.queryByText(/%\)/)).not.toBeInTheDocument();
    expect(screen.getByText(/too small a base/)).toBeInTheDocument();
  });

  it("states a refusal rather than showing nothing", () => {
    // An absent trend and a flat one look identical otherwise, and they
    // mean very different things.
    const c = comparePaid(paid(), paid({ days_covered: 3 }));
    render(<TrendLine comparison={c} label="Clicks" />);
    expect(screen.getByText(/too uneven to compare/)).toBeInTheDocument();
  });

  it("says a first window with data is not a rise from zero", () => {
    const c = comparePaid(paid(), paid({ days_covered: 0 }));
    render(<TrendLine comparison={c} label="Clicks" />);
    expect(screen.getByText(/first window with data, not a rise from zero/)).toBeInTheDocument();
  });

  it("renders nothing for a figure that was not compared", () => {
    const c: Comparison = { deltas: [], refusal: null };
    const { container } = render(<TrendLine comparison={c} label="Clicks" />);
    expect(container).toBeEmptyDOMElement();
  });
});

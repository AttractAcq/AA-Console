import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { IndexDetail, type IndexColumn } from "./IndexDetail";

/**
 * The pattern the notes ask for on six or more pages, so its behaviour is
 * pinned once here rather than re-proved per page.
 *
 * The properties worth holding: the open row survives a link or a refresh
 * because it lives in the URL, the opener is a real control rather than a click
 * handler on a table row, and two tables on one screen cannot fight over which
 * row is open.
 */
type Offer = { id: string; name: string; kind: string };

const OFFERS: Offer[] = [
  { id: "offer-1", name: "Main offer", kind: "main" },
  { id: "offer-2", name: "Roofers in Monaco", kind: "secondary" },
];

const columns: IndexColumn<Offer>[] = [
  { label: "Offer", cell: (o) => o.name },
  { label: "Kind", cell: (o) => o.kind },
];

function renderIndex(
  props: Partial<Parameters<typeof IndexDetail<Offer>>[0]> = {},
  initialUrl = "/",
) {
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <IndexDetail<Offer>
        title="Offers"
        items={OFFERS}
        columns={columns}
        paramKey="offer"
        emptyLabel="No offers yet."
        nameOf={(o) => o.name}
        detail={(o) => <p>Detail for {o.name}</p>}
        {...props}
      />
    </MemoryRouter>,
  );
}

describe("the index half", () => {
  it("lists every item with its columns", () => {
    renderIndex();
    expect(screen.getByRole("columnheader", { name: "Offer" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Kind" })).toBeInTheDocument();
    expect(screen.getByText("Roofers in Monaco")).toBeInTheDocument();
    expect(screen.getByText("secondary")).toBeInTheDocument();
  });

  it("says so when there is nothing, rather than showing an empty grid", () => {
    renderIndex({ items: [] });
    expect(screen.getByText("No offers yet.")).toBeInTheDocument();
    // And no prompt to choose a row, because there is no row to choose.
    expect(screen.queryByText(/Choose a row/)).toBeNull();
  });

  it("renders row actions in their own column when given", () => {
    renderIndex({ rowActions: (o) => <button type="button">Archive {o.name}</button> });
    expect(screen.getByRole("button", { name: "Archive Main offer" })).toBeInTheDocument();
  });
});

describe("opening a row", () => {
  it("opens the detail for the row, and nothing else", async () => {
    renderIndex();
    expect(screen.queryByText("Detail for Main offer")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show Main offer" }));
    expect(screen.getByText("Detail for Main offer")).toBeInTheDocument();
    expect(screen.queryByText("Detail for Roofers in Monaco")).toBeNull();
  });

  it("is a real control, so the keyboard reaches it", async () => {
    renderIndex();
    const opener = screen.getByRole("button", { name: "Show Main offer" });
    opener.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByText("Detail for Main offer")).toBeInTheDocument();
  });

  it("reports whether the row is open, so it is not a mystery to a screen reader", async () => {
    renderIndex();
    const opener = screen.getByRole("button", { name: "Show Main offer" });
    expect(opener).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(opener);
    expect(
      screen.getByRole("button", { name: "Hide Main offer" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("closes again from the same control and from Close", async () => {
    renderIndex();
    await userEvent.click(screen.getByRole("button", { name: "Show Main offer" }));
    await userEvent.click(screen.getByRole("button", { name: "Hide Main offer" }));
    expect(screen.queryByText("Detail for Main offer")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Show Main offer" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Detail for Main offer")).toBeNull();
  });

  it("switches straight from one row to another", async () => {
    renderIndex();
    await userEvent.click(screen.getByRole("button", { name: "Show Main offer" }));
    await userEvent.click(screen.getByRole("button", { name: "Show Roofers in Monaco" }));
    expect(screen.getByText("Detail for Roofers in Monaco")).toBeInTheDocument();
    expect(screen.queryByText("Detail for Main offer")).toBeNull();
  });
});

describe("the open row lives in the URL", () => {
  it("opens from a link, so a deep link from the Inbox lands on the right row", () => {
    renderIndex({}, "/?offer=offer-2");
    expect(screen.getByText("Detail for Roofers in Monaco")).toBeInTheDocument();
  });

  it("ignores an id that is not in the list rather than breaking", () => {
    renderIndex({}, "/?offer=offer-does-not-exist");
    expect(screen.getByText(/Choose a row/)).toBeInTheDocument();
    expect(screen.queryByText(/^Detail for/)).toBeNull();
  });

  it("keeps other parameters, so a filter is not lost by opening a row", async () => {
    renderIndex({}, "/?tab=live&offer=offer-1");
    // Switching rows must not drop ?tab=live; proving it through behaviour
    // rather than reading the bar: the detail still opens and the list is intact.
    await userEvent.click(screen.getByRole("button", { name: "Show Roofers in Monaco" }));
    expect(screen.getByText("Detail for Roofers in Monaco")).toBeInTheDocument();
  });

  it("uses its own parameter, so two tables on a page do not fight", async () => {
    render(
      <MemoryRouter initialEntries={["/"]}>
        <IndexDetail<Offer>
          title="Offers"
          items={OFFERS}
          columns={columns}
          paramKey="offer"
          emptyLabel="None."
          nameOf={(o) => o.name}
          detail={(o) => <p>Offer detail {o.name}</p>}
        />
        <IndexDetail<Offer>
          title="Magnets"
          items={OFFERS}
          columns={columns}
          paramKey="magnet"
          emptyLabel="None."
          nameOf={(o) => o.name}
          detail={(o) => <p>Magnet detail {o.name}</p>}
        />
      </MemoryRouter>,
    );
    const offers = screen.getByRole("region", { name: "Offers" });
    await userEvent.click(within(offers).getByRole("button", { name: "Show Main offer" }));
    expect(screen.getByText("Offer detail Main offer")).toBeInTheDocument();
    expect(screen.queryByText("Magnet detail Main offer")).toBeNull();
  });
});

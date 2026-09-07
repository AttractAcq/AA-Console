import { render, act } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { useScrollToTop } from "./useScrollToTop";

/** A shell shaped like the real one: the scroll lives on <main>, not the window. */
function Shell({ onNav }: { onNav?: (go: (to: string) => void) => void }) {
  const ref = useScrollToTop<HTMLElement>();
  const navigate = useNavigate();
  useEffect(() => {
    onNav?.((to: string) => navigate(to));
  }, [navigate, onNav]);
  return (
    <main ref={ref} data-testid="main" style={{ height: 100, overflowY: "auto" }}>
      <div style={{ height: 5000 }} />
    </main>
  );
}

function mount(initial = "/a") {
  let go: (to: string) => void = () => {};
  const view = render(
    <MemoryRouter initialEntries={[initial]}>
      <Shell onNav={(fn) => (go = fn)} />
    </MemoryRouter>,
  );
  const main = view.getByTestId("main");
  return { ...view, main, go: (to: string) => act(() => go(to)) };
}

describe("useScrollToTop", () => {
  it("puts the page back at the top when the path changes", () => {
    const { main, go } = mount("/a");
    main.scrollTop = 2435;
    go("/b");
    expect(main.scrollTop).toBe(0);
  });

  // ?tab= is how this app switches tabs, and a new tab is new content.
  it("also resets when only the tab query changes", () => {
    const { main, go } = mount("/team");
    main.scrollTop = 800;
    go("/team?tab=avatars");
    expect(main.scrollTop).toBe(0);
  });

  // Otherwise any re-render would yank a reader back to the top mid-page.
  it("does not fight the user when the location has not changed", () => {
    const { main, go } = mount("/a");
    main.scrollTop = 600;
    go("/a");
    expect(main.scrollTop).toBe(600);
  });

  // The shells are h-screen overflow-hidden with overflow-y-auto inside, so
  // the document never scrolls. A window-only reset would be a silent no-op,
  // which is exactly the bug this hook exists to avoid re-introducing.
  it("resets horizontal scroll too, for a wide table left mid-scroll", () => {
    const { main, go } = mount("/a");
    main.scrollLeft = 260;
    go("/b");
    expect(main.scrollLeft).toBe(0);
  });

  it("survives being used without an attached element", () => {
    function Bare() {
      useScrollToTop<HTMLElement>();
      return <p>no ref attached</p>;
    }
    expect(() =>
      render(
        <MemoryRouter initialEntries={["/a"]}>
          <Bare />
        </MemoryRouter>,
      ),
    ).not.toThrow();
  });
});

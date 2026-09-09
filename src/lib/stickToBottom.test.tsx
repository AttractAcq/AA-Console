import { describe, expect, it, vi } from "vitest";
import { stickToBottom } from "./stickToBottom";

/**
 * The shape that caused the bug: the shell's scrollable <main>, with a
 * scrollable chat list inside it partway down the page.
 */
function shellWithChat() {
  const main = document.createElement("main");
  const list = document.createElement("div");
  main.appendChild(list);
  document.body.appendChild(main);

  // jsdom does no layout, so heights are declared rather than measured.
  Object.defineProperty(main, "scrollHeight", { value: 3000, configurable: true });
  Object.defineProperty(list, "scrollHeight", { value: 800, configurable: true });
  return { main, list };
}

describe("stickToBottom", () => {
  it("scrolls the list to its newest message", () => {
    const { list } = shellWithChat();
    list.scrollTop = 0;
    stickToBottom(list);
    expect(list.scrollTop).toBe(800);
  });

  it("leaves the page above it exactly where it was", () => {
    // Documents the intent. On its own it is weak: jsdom's scrollIntoView is a
    // no-op, so this would pass even with the bug present. The spy below is the
    // assertion that actually holds the fix in place.
    const { main, list } = shellWithChat();
    main.scrollTop = 0;
    stickToBottom(list);
    expect(main.scrollTop).toBe(0);
  });

  it("never reaches for scrollIntoView, which would scroll every ancestor", () => {
    // This is the real regression guard. scrollIntoView is the obvious way to
    // write this and is exactly what dragged both dashboards down after
    // useScrollToTop had correctly put them at the top — and jsdom cannot
    // reproduce that effect, so the only way to lock it out is to assert the
    // call is never made.
    // jsdom does not implement scrollIntoView at all, so it has to be planted
    // before it can be watched.
    const spy = vi.fn();
    const proto = Element.prototype as unknown as { scrollIntoView?: unknown };
    proto.scrollIntoView = spy;
    try {
      const { list } = shellWithChat();
      stickToBottom(list);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      delete proto.scrollIntoView;
    }
  });

  it("does not disturb a page the reader has scrolled themselves", () => {
    const { main, list } = shellWithChat();
    main.scrollTop = 450;
    stickToBottom(list);
    expect(main.scrollTop).toBe(450);
    expect(list.scrollTop).toBe(800);
  });

  it("does nothing when there is no list yet", () => {
    expect(() => stickToBottom(null)).not.toThrow();
  });
});

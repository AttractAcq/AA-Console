import { describe, expect, it, beforeEach, vi } from "vitest";
import { JSDOM } from "jsdom";
import { WIDGET_SOURCE } from "./widget.js";

/**
 * Run the widget the way a visitor's browser does.
 *
 * It was only ever asserted against as a string, which can confirm it parses
 * and cannot confirm it works. This runs on client pages in front of real
 * prospects, so what is worth testing is behaviour: that dismissing the
 * invitation does not open the chat it just declined, and that somebody who
 * moves to a second page still sees what they said on the first.
 */
async function mount(widgetConfig: Record<string, unknown> = {}, session: Record<string, string> = {}) {
  const dom = new JSDOM(
    `<!doctype html><html><body><script id="w" data-agent="dep123" data-runtime="https://runtime.example"></script></body></html>`,
    { runScripts: "outside-only", url: "https://attractacq-sites.github.io/aa-offers/p/" },
  );
  const win = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;
  for (const [k, v] of Object.entries(session)) win.sessionStorage.setItem(k, v);

  const widget = {
    label: "Chat",
    accent: null,
    title: null,
    teaser: "Welcome to Attract, ask me anything",
    ...widgetConfig,
  };
  const sent: string[] = [];
  win.fetch = vi.fn(async (url: string, init?: { body?: string }) => {
    if (String(url).endsWith("/config")) {
      return { ok: true, json: async () => ({ ok: true, greeting: "Hello", widget }) };
    }
    sent.push(String(init?.body ?? ""));
    return { ok: true, json: async () => ({ ok: true, reply: "Certainly.", conversation_id: "conv-1" }) };
  }) as unknown as typeof fetch;

  // document.currentScript is not settable in jsdom, so the widget is handed
  // the tag it would otherwise have found.
  Object.defineProperty(win.document, "currentScript", {
    value: win.document.getElementById("w"),
    configurable: true,
  });

  win.eval(WIDGET_SOURCE);
  await new Promise((r) => setTimeout(r, 0));

  const shadow = win.document.querySelector("[data-aa-sales-agent]")?.shadowRoot;
  if (!shadow) throw new Error("the widget did not mount");
  return { win, shadow, sent };
}

const q = (shadow: ShadowRoot, sel: string) => shadow.querySelector(sel) as HTMLElement | null;

async function send(win: Window & { Event: typeof Event }, shadow: ShadowRoot, text: string) {
  const input = q(shadow, ".form input") as HTMLInputElement;
  input.value = text;
  q(shadow, ".form")?.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => vi.clearAllMocks());

describe("the closed widget", () => {
  it("is a circle carrying a robot, not a text pill", async () => {
    const { shadow } = await mount();
    const launch = q(shadow, ".launch");
    expect(launch?.querySelector("svg")).not.toBeNull();
    // A circle with no text still has to be nameable by a screen reader.
    expect(launch?.getAttribute("aria-label")).toBe("Chat");
    expect(launch?.textContent?.trim()).toBe("");
  });

  it("invites the visitor with the line the deployment configured", async () => {
    const { shadow } = await mount();
    expect(q(shadow, ".teaser")?.textContent).toContain("Welcome to Attract, ask me anything");
  });

  it("falls back to a sensible invitation when none is configured", async () => {
    const { shadow } = await mount({ teaser: null });
    expect(q(shadow, ".teaser")?.textContent).toMatch(/ask me anything/i);
  });

  it("opens the chat when the invitation itself is clicked", async () => {
    const { shadow } = await mount();
    q(shadow, ".teaser")?.click();
    expect(q(shadow, ".panel")).not.toBeNull();
  });
});

describe("dismissing the invitation", () => {
  it("removes it WITHOUT opening the chat the visitor just declined", async () => {
    // The × sits inside the teaser. Without stopPropagation the click reaches
    // the teaser and opens the panel — the opposite of what was asked for.
    const { shadow } = await mount();
    q(shadow, ".teaser .dismiss")?.click();
    expect(q(shadow, ".teaser")).toBeNull();
    expect(q(shadow, ".panel")).toBeNull();
    // Dismissing the message is not dismissing the agent.
    expect(q(shadow, ".launch")).not.toBeNull();
  });

  it("stays dismissed on the next page, because it was a decision", async () => {
    const { shadow } = await mount({}, { "aa-sales-dep123-teaser": "1" });
    expect(q(shadow, ".teaser")).toBeNull();
    expect(q(shadow, ".launch")).not.toBeNull();
  });

  it("does not invite somebody already talking to it", async () => {
    const { shadow } = await mount({}, {
      "aa-sales-dep123-log": JSON.stringify([{ role: "user", content: "hi" }]),
    });
    expect(q(shadow, ".teaser")).toBeNull();
  });
});

describe("memory for the session", () => {
  it("shows what was already said when the visitor lands on another page", async () => {
    const { shadow } = await mount({}, {
      "aa-sales-dep123": "conv-1",
      "aa-sales-dep123-log": JSON.stringify([
        { role: "user", content: "Do you work with dentists?" },
        { role: "assistant", content: "Yes, frequently." },
      ]),
    });
    q(shadow, ".launch")?.click();
    const log = q(shadow, ".log");
    expect(log?.textContent).toContain("Do you work with dentists?");
    expect(log?.textContent).toContain("Yes, frequently.");
  });

  it("keeps the transcript as the conversation happens", async () => {
    const { win, shadow } = await mount();
    q(shadow, ".launch")?.click();
    await send(win, shadow, "What do you charge?");
    const stored = JSON.parse(win.sessionStorage.getItem("aa-sales-dep123-log") ?? "[]");
    expect(stored.map((m: { content: string }) => m.content)).toContain("What do you charge?");
    // The conversation id is what lets the SERVER remember; the log is what
    // lets the visitor see it.
    expect(win.sessionStorage.getItem("aa-sales-dep123")).toBe("conv-1");
  });

  it("carries the conversation id so the agent is not asked to start over", async () => {
    const { win, shadow, sent } = await mount({}, { "aa-sales-dep123": "conv-earlier" });
    q(shadow, ".launch")?.click();
    await send(win, shadow, "Still there?");
    expect(sent.some((body) => body.includes("conv-earlier"))).toBe(true);
  });
});

describe("opening and closing", () => {
  it("retires the invitation, which has been answered", async () => {
    const { win, shadow } = await mount();
    q(shadow, ".launch")?.click();
    expect(win.sessionStorage.getItem("aa-sales-dep123-teaser")).toBe("1");
  });

  it("closes back to the circle without losing what was said", async () => {
    const { shadow } = await mount({}, {
      "aa-sales-dep123-log": JSON.stringify([{ role: "user", content: "earlier question" }]),
    });
    q(shadow, ".launch")?.click();
    q(shadow, ".close")?.click();
    expect(q(shadow, ".launch")).not.toBeNull();
    q(shadow, ".launch")?.click();
    expect(q(shadow, ".log")?.textContent).toContain("earlier question");
  });
});

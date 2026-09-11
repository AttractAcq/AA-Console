import { describe, expect, it } from "vitest";
import { shellFiles, shellPaths } from "./shell.js";

const opts = {
  clientName: "Harbour Dental",
  repo: "harbour-dental-site",
  runtimeBase: "https://runtime.attractacq.com",
};

describe("shellFiles", () => {
  const files = shellFiles(opts);
  const byPath = new Map(files.map((f) => [f.path, f.content]));

  it("includes .nojekyll, without which Pages mangles generated HTML", () => {
    // Branch-based Pages runs everything through Jekyll by default, which
    // ignores underscore-prefixed paths and rewrites content. The file being
    // empty is the point — its existence is the instruction.
    expect(byPath.has(".nojekyll")).toBe(true);
    expect(byPath.get(".nojekyll")).toBe("");
  });

  it("ships a homepage so a fresh site is not a 404", () => {
    const index = byPath.get("index.html") ?? "";
    expect(index).toContain("<!doctype html>");
    expect(index).toContain("Harbour Dental");
    expect(index).toContain("viewport");
  });

  it("keeps a fresh shell out of search results", () => {
    // An unfinished placeholder indexing under the client's name is worse than
    // no site at all.
    expect(byPath.get("index.html")).toContain('name="robots" content="noindex"');
  });

  it("escapes the client name rather than injecting it raw", () => {
    const hostile = shellFiles({ ...opts, clientName: '<script>alert(1)</script>' });
    const index = hostile.find((f) => f.path === "index.html")?.content ?? "";
    expect(index).not.toContain("<script>alert(1)</script>");
    expect(index).toContain("&lt;script&gt;");
  });

  it("writes valid JSON site identity", () => {
    const raw = byPath.get("aa/config.json") ?? "";
    const parsed = JSON.parse(raw);
    expect(parsed.client).toBe("Harbour Dental");
    expect(parsed.runtime).toBe("https://runtime.attractacq.com");
  });

  it("puts no secret, key, prompt or agent id anywhere in the repo", () => {
    // The repo is served publicly by Pages. Anything here is public.
    const everything = files.map((f) => `${f.path}\n${f.content}`).join("\n").toLowerCase();
    // Credential shapes and internal field names, not the word "secret" — the
    // README deliberately says nothing secret belongs here, which is prose
    // worth keeping in a repository that is served publicly.
    for (const forbidden of [
      "anthropic", "service_role", "sk-", "api_key", "apikey",
      "private_key", "system_prompt", "guardrails", "data-agent", "bearer ",
    ]) {
      expect(everything).not.toContain(forbidden);
    }
  });

  it("reserves a place for shared assets so the first publish does not invent one", () => {
    expect(byPath.has("assets/.gitkeep")).toBe(true);
  });

  it("normalises a trailing slash on the runtime base", () => {
    const f = shellFiles({ ...opts, runtimeBase: "https://runtime.attractacq.com/" });
    const parsed = JSON.parse(f.find((x) => x.path === "aa/config.json")?.content ?? "{}");
    expect(parsed.runtime).toBe("https://runtime.attractacq.com");
  });
});

describe("shellPaths", () => {
  it("names every path the shell owns, so a page cannot publish over one", () => {
    const paths = shellPaths();
    expect(paths).toContain(".nojekyll");
    expect(paths).toContain("index.html");
    expect(paths).toContain("aa/config.json");
  });
});

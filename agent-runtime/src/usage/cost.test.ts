import { describe, expect, it } from "vitest";
import { elevenLabsUsd, elevenMusicUsd } from "./cost.js";

describe("published ElevenAPI list-price estimates", () => {
  it("prices each paid v3 text generation and one music duration", () => {
    expect(elevenLabsUsd(1000)).toBe(0.1);
    expect(elevenLabsUsd(20)).toBe(0.002);
    expect(elevenMusicUsd(60)).toBe(0.15);
    expect(elevenMusicUsd(122)).toBe(0.305);
  });
  it("refuses units outside the provider request contract", () => {
    expect(() => elevenLabsUsd(-1)).toThrow();
    expect(() => elevenLabsUsd(1.5)).toThrow();
    expect(() => elevenMusicUsd(Number.NaN)).toThrow();
    expect(() => elevenMusicUsd(901)).toThrow();
  });
});

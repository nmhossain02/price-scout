import { describe, expect, it } from "vitest";
import { formatDuration, formatMoney, hostname, labelize } from "./format";

describe("format helpers", () => {
  it("formats integer minor units as currency", () => {
    expect(formatMoney(12999, "USD")).toMatch(/129\.99/);
    expect(formatMoney(undefined, "USD")).toBe("—");
  });

  it("formats durations at useful operator resolutions", () => {
    expect(formatDuration(480)).toBe("480ms");
    expect(formatDuration(1_250)).toBe("1.3s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  it("creates readable source and state labels", () => {
    expect(hostname("https://www.example.com/product/1")).toBe("example.com");
    expect(labelize("needs_review")).toBe("Needs Review");
  });
});

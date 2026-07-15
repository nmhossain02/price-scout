import { describe, expect, it } from "vitest";
import {
  assertSafeAction,
  assertSafeActionTarget,
  isPrivateAddress,
  validateTargetUrl,
} from "../src/safety.js";

describe("target and action safety", () => {
  it("allows the explicitly configured local fixture", async () => {
    await expect(validateTargetUrl("http://127.0.0.1:4173/product", new Set(["127.0.0.1"]))).resolves.toBeInstanceOf(URL);
  });

  it("rejects IP literals, credentials, unsafe ports, and schemes", async () => {
    await expect(validateTargetUrl("http://127.0.0.1/product", new Set())).rejects.toThrow("IP-literal");
    await expect(validateTargetUrl("https://user:password@example.com/product", new Set())).rejects.toThrow("Credentials");
    await expect(validateTargetUrl("https://example.com:6379/product", new Set())).rejects.toThrow("Port");
    await expect(validateTargetUrl("file:///etc/passwd", new Set())).rejects.toThrow("HTTP");
  });

  it.each([
    "192.0.0.8",
    "192.0.2.8",
    "198.18.0.1",
    "198.19.255.254",
    "198.51.100.8",
    "203.0.113.8",
    "ff02::1",
    "2001:db8::1",
  ])("recognizes special-use address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it("permits selection clicks but denies purchases and text entry", () => {
    expect(() => assertSafeAction({ selector: "xpath=//button", description: "Choose black", method: "click" })).not.toThrow();
    expect(() => assertSafeAction({ selector: "xpath=//button", description: "Buy now", method: "click" })).toThrow("Purchase");
    expect(() => assertSafeAction({ selector: "xpath=//input", description: "Enter address", method: "fill" })).toThrow("not permitted");
  });

  it("inspects the concrete action target while allowing stale selectors to self-heal", async () => {
    const page = (count: number, text: string, html = "") => ({
      locator: () => ({
        first: () => ({
          count: async () => count,
          innerText: async () => text,
          innerHtml: async () => html,
        }),
      }),
    });
    const action = { selector: "xpath=//button", description: "Choose silver", method: "click" };

    await expect(assertSafeActionTarget(page(1, "Silver") as never, action)).resolves.toBe(true);
    await expect(assertSafeActionTarget(page(1, "Add to cart") as never, action)).rejects.toThrow(
      "located action target",
    );
    await expect(assertSafeActionTarget(page(0, "") as never, action)).resolves.toBe(false);
  });
});

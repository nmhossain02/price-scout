import { describe, expect, it } from "vitest";
import { fingerprint, parsePrice, titleSimilarity, validateObservation, ValidationError } from "../src/validation.js";
import type { MonitorPlanV1, Observation } from "../src/contracts.js";

const plan: MonitorPlanV1 = {
  schemaVersion: 1,
  stagehandVersion: "3.7.0",
  canonicalUrl: "https://shop.example/product",
  identity: {
    title: "Atlas Studio Headphones",
    sku: "ASH-100",
    fingerprint: fingerprint("Atlas Studio Headphones", "ASH-100"),
    requestedVariant: { color: "black" },
  },
  preparationSteps: [],
  extractors: {
    title: [{ kind: "xpathText", selector: "xpath=//h1" }],
    price: [{ kind: "xpathText", selector: "xpath=//*[@class='price']" }],
    availability: [{ kind: "xpathText", selector: "xpath=//*[@class='stock']" }],
    selectedVariant: [{ kind: "xpathText", selector: "xpath=//*[@class='selected']", attribute: "color" }],
  },
  expectedCurrency: "USD",
  validatorVersion: 1,
};

const observation: Observation = {
  title: "Atlas Studio Headphones",
  sku: "ASH-100",
  priceMinor: 109_900,
  currency: "USD",
  inStock: true,
  availabilityRaw: "In stock",
  selectedVariant: { color: "black" },
  rawPrice: "$1,099.00",
  identityFingerprint: plan.identity.fingerprint,
};

describe("price and identity validation", () => {
  it.each([
    ["$1,249.99", 124_999, "USD"],
    ["US$1,249.99", 124_999, "USD"],
    ["C$1,249.99", 124_999, "CAD"],
    ["A$1,249.99", 124_999, "AUD"],
    ["EUR 1.249,99", 124_999, "EUR"],
    ["EUR 1.249", 124_900, "EUR"],
    ["USD 999.00 incl VAT", 99_900, "USD"],
    ["1 099,00 €", 109_900, "EUR"],
    ["1\u00a0099,00 €", 109_900, "EUR"],
    ["£79", 7_900, "GBP"],
  ])("parses a single current price", (raw, priceMinor, currency) => {
    expect(parsePrice(raw)).toEqual({ priceMinor, currency });
  });

  it.each(["From $19.00", "$19 / month", "Was $99, now $79", "free"])(
    "rejects ambiguous price %s",
    (raw) => expect(() => parsePrice(raw)).toThrow(ValidationError),
  );

  it.each(["JPY 1,000", "jpy 1,000", "¥1,000", "CHF 19.00", "$19 CAD"])(
    "rejects unsupported or conflicting currency %s",
    (raw) => expect(() => parsePrice(raw)).toThrow(ValidationError),
  );

  it("requires exact SKU and selected variant", () => {
    expect(() => validateObservation(observation, plan)).not.toThrow();
    expect(() => validateObservation({ ...observation, sku: "OTHER" }, plan)).toThrow("SKU");
    expect(() =>
      validateObservation({ ...observation, selectedVariant: { color: "silver" } }, plan),
    ).toThrow("variant");
  });

  it("uses conservative token similarity when SKU is unavailable", () => {
    expect(titleSimilarity("Atlas Studio Headphones", "Atlas Studio Headphones — Black")).toBeGreaterThan(0.7);
    expect(titleSimilarity("Atlas Studio Headphones", "Monthly protection plan")).toBeLessThan(0.2);
  });
});

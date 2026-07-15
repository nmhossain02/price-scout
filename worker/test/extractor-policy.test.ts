import type { Page } from "@browserbasehq/stagehand";
import { describe, expect, it } from "vitest";
import type { MonitorPlanV1 } from "../src/contracts.js";
import { extractObservation } from "../src/extract.js";
import { buildLiveExtractors } from "../src/extractorPolicy.js";
import { fingerprint } from "../src/validation.js";

describe("live extractor fallback policy", () => {
  it("fails stale variant price extraction instead of accepting the base JSON-LD offer", async () => {
    const extractors = buildLiveExtractors({
      requestedVariant: { color: "black" },
      title: xpath("//h1"),
      sku: xpath("//*[@data-variant-sku]"),
      price: xpath("//*[@data-current-price]"),
      availability: xpath("//*[@data-stock]"),
      selectedVariant: [xpath("//*[@data-selected-color]", "color")],
    });
    const plan = monitorPlan(extractors, { color: "black" });
    const page = fakePage({
      "xpath=//h1": "Atlas Studio Headphones",
      "xpath=//*[@data-variant-sku]": "BLACK-SKU",
      "xpath=//*[@data-stock]": "In stock",
      "xpath=//*[@data-selected-color]": "black",
    }, {
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Atlas Studio Headphones",
      sku: "BASE-SKU",
      offers: {
        "@type": "Offer",
        price: "499.00",
        priceCurrency: "USD",
        availability: "https://schema.org/InStock",
      },
    });

    expect(extractors.price).toEqual([xpath("//*[@data-current-price]")]);
    expect(extractors.availability).toEqual([xpath("//*[@data-stock]")]);
    expect(extractors.sku).toEqual([xpath("//*[@data-variant-sku]")]);
    await expect(extractObservation(page, plan)).rejects.toThrow(
      /No price extractor succeeded/,
    );
  });

  it("retains generic Product JSON-LD fallback for monitors without a variant", () => {
    const extractors = buildLiveExtractors({
      requestedVariant: {},
      title: xpath("//h1"),
      price: xpath("//*[@data-current-price]"),
      availability: xpath("//*[@data-stock]"),
      selectedVariant: [],
    });

    expect(extractors.price.at(-1)).toEqual({ kind: "jsonLd", field: "price" });
    expect(extractors.availability.at(-1)).toEqual({ kind: "jsonLd", field: "availability" });
    expect(extractors.sku).toEqual([{ kind: "jsonLd", field: "sku" }]);
  });
});

function xpath(selector: string, attribute?: string) {
  return {
    kind: "xpathText" as const,
    selector: `xpath=${selector}` as `xpath=${string}`,
    ...(attribute ? { attribute } : {}),
  };
}

function monitorPlan(
  extractors: MonitorPlanV1["extractors"],
  requestedVariant: Record<string, string>,
): MonitorPlanV1 {
  return {
    schemaVersion: 1,
    stagehandVersion: "3.7.0",
    canonicalUrl: "https://shop.example/product",
    identity: {
      title: "Atlas Studio Headphones",
      fingerprint: fingerprint("Atlas Studio Headphones"),
      requestedVariant,
    },
    preparationSteps: [],
    extractors,
    expectedCurrency: "USD",
    validatorVersion: 1,
  };
}

function fakePage(
  textBySelector: Record<string, string>,
  jsonLd: Record<string, unknown>,
): Page {
  return {
    locator(selector: string) {
      if (selector === "script[type='application/ld+json']") {
        return {
          count: async () => 1,
          nth: () => ({ textContent: async () => JSON.stringify(jsonLd) }),
        };
      }
      return {
        first: () => ({
          innerText: async () => {
            const value = textBySelector[selector];
            if (value === undefined) throw new Error(`stale selector: ${selector}`);
            return value;
          },
          inputValue: async () => {
            const value = textBySelector[selector];
            if (value === undefined) throw new Error(`stale selector: ${selector}`);
            return value;
          },
        }),
      };
    },
  } as unknown as Page;
}

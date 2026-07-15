import type { ExtractionStrategy, MonitorPlanV1 } from "./contracts.js";

interface LiveExtractorInputs {
  requestedVariant: Record<string, string>;
  title: ExtractionStrategy;
  sku?: ExtractionStrategy;
  price: ExtractionStrategy;
  currency?: ExtractionStrategy;
  availability: ExtractionStrategy;
  selectedVariant: ExtractionStrategy[];
}

/**
 * Generic Product JSON-LD commonly describes the default/base offer rather than
 * the variant selected in the rendered UI. It is therefore a useful fallback
 * only when the monitor has no variant constraint. Variant monitors must fail
 * closed when their variant-bound DOM price or availability becomes stale so
 * the coordinated repair path can rediscover the correct evidence.
 */
export function buildLiveExtractors(
  input: LiveExtractorInputs,
): MonitorPlanV1["extractors"] {
  const variantBound = Object.keys(input.requestedVariant).length > 0;
  const jsonLd = (
    field: "title" | "sku" | "price" | "currency" | "availability",
  ): ExtractionStrategy => ({ kind: "jsonLd", field });

  return {
    title: [input.title, jsonLd("title")],
    ...(!input.sku
      ? variantBound
        ? {}
        : { sku: [jsonLd("sku")] }
      : {
          sku: variantBound
            ? [input.sku]
            : [input.sku, jsonLd("sku")],
        }),
    price: variantBound
      ? [input.price]
      : [input.price, jsonLd("price")],
    currency: input.currency
      ? [input.currency, jsonLd("currency")]
      : [jsonLd("currency")],
    availability: variantBound
      ? [input.availability]
      : [input.availability, jsonLd("availability")],
    selectedVariant: input.selectedVariant,
  };
}

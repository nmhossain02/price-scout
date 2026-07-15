import { createHash } from "node:crypto";
import type { MonitorPlanV1, Observation, SupportedCurrency } from "./contracts.js";

export class ValidationError extends Error {
  constructor(message: string, readonly reason: "identity_drift" | "ambiguous_value") {
    super(message);
    this.name = "ValidationError";
  }
}

const supportedCurrencies = new Set<SupportedCurrency>(["USD", "CAD", "EUR", "GBP", "AUD"]);
const currencySymbols: Readonly<Record<string, SupportedCurrency>> = {
  "US$": "USD",
  "C$": "CAD",
  "A$": "AUD",
  "$": "USD",
  "€": "EUR",
  "£": "GBP",
};

export function parsePrice(raw: string): { priceMinor: number; currency?: SupportedCurrency } {
  const compact = raw.replace(/[\u00a0\u202f]/g, " ").trim();
  if (/\b(from|starting at|per month|monthly|installment|finance)\b|\/\s*mo(?:nth)?\b/i.test(compact)) {
    throw new ValidationError(`Ambiguous non-total price: ${compact}`, "ambiguous_value");
  }

  if (/[¥₹₽₩₺₫฿₱₦₴₪]/u.test(compact) || /\bJPY\b/i.test(compact)) {
    throw new ValidationError("This currency is not supported in price monitor v1", "ambiguous_value");
  }

  const detectedCurrencies = new Set<SupportedCurrency>();
  for (const match of compact.matchAll(/US\$|C\$|A\$|\$|€|£/gi)) {
    const symbol = match[0]!.replace(/^us\$/i, "US$").replace(/^c\$/i, "C$").replace(/^a\$/i, "A$");
    const currency = currencySymbols[symbol];
    if (currency) detectedCurrencies.add(currency);
  }
  for (const match of compact.matchAll(/\b(?:USD|CAD|EUR|GBP|AUD)\b/gi)) {
    detectedCurrencies.add(match[0]!.toUpperCase() as SupportedCurrency);
  }
  if (detectedCurrencies.size > 1) {
    throw new ValidationError("Price text contains conflicting currencies", "ambiguous_value");
  }
  const currency = detectedCurrencies.values().next().value as SupportedCurrency | undefined;
  const numericMatches = [
    ...compact.matchAll(
      /(?:\d{1,3}(?: \d{3})+(?:[.,]\d{1,2})?|(?:\d{1,3}(?:[,.]\d{3})+|\d+)(?:[.,]\d{1,2})?)/g,
    ),
  ];
  if (numericMatches.length !== 1) {
    throw new ValidationError(`Expected one current price, found ${numericMatches.length}`, "ambiguous_value");
  }
  const numericMatch = numericMatches[0]!;
  const start = numericMatch.index;
  const before = compact.slice(0, start).trimEnd();
  const after = compact.slice(start + numericMatch[0].length).trimStart();
  const adjacentCodes = [
    before.match(/\b([A-Z]{3})\b\s*$/)?.[1],
    after.match(/^([A-Z]{3})\b/)?.[1],
  ].filter((code): code is string => Boolean(code));
  const unsupportedCode = adjacentCodes.find(
    (code) => !supportedCurrencies.has(code as SupportedCurrency),
  );
  if (unsupportedCode) {
    throw new ValidationError(`Currency ${unsupportedCode} is not supported in price monitor v1`, "ambiguous_value");
  }

  let numeric = numericMatch[0].replace(/ /g, "");
  const lastComma = numeric.lastIndexOf(",");
  const lastDot = numeric.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0 && lastComma > lastDot) {
    numeric = numeric.replace(/\./g, "").replace(",", ".");
  } else if (lastComma >= 0 && lastDot >= 0) {
    numeric = numeric.replace(/,/g, "");
  } else {
    const separator = lastComma >= 0 ? "," : lastDot >= 0 ? "." : undefined;
    if (separator) {
      const last = numeric.lastIndexOf(separator);
      const fractionDigits = numeric.length - last - 1;
      if (fractionDigits === 3) {
        numeric = numeric.replaceAll(separator, "");
      } else {
        const integer = numeric.slice(0, last).replaceAll(separator, "");
        numeric = `${integer}.${numeric.slice(last + 1)}`;
      }
    }
  }
  const value = Number(numeric);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ValidationError("Price must be a positive finite number", "ambiguous_value");
  }
  return { priceMinor: Math.round(value * 100), ...(currency ? { currency } : {}) };
}

export function fingerprint(title: string, sku?: string): string {
  return createHash("sha256")
    .update(`${normalize(title)}\0${normalize(sku ?? "")}`)
    .digest("hex");
}

export function titleSimilarity(left: string, right: string): number {
  const a = new Set(normalize(left).split(" ").filter(Boolean));
  const b = new Set(normalize(right).split(" ").filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / new Set([...a, ...b]).size;
}

export function validateObservation(observation: Observation, plan: MonitorPlanV1): void {
  if (observation.currency !== plan.expectedCurrency) {
    throw new ValidationError(
      `Expected ${plan.expectedCurrency}, observed ${observation.currency}`,
      "ambiguous_value",
    );
  }
  if (plan.identity.sku && observation.sku) {
    if (normalize(plan.identity.sku) !== normalize(observation.sku)) {
      throw new ValidationError("Product SKU changed", "identity_drift");
    }
  } else if (titleSimilarity(plan.identity.title, observation.title) < 0.8) {
    throw new ValidationError("Product title no longer matches the compiled identity", "identity_drift");
  }
  for (const [attribute, expected] of Object.entries(plan.identity.requestedVariant)) {
    if (normalize(observation.selectedVariant[attribute] ?? "") !== normalize(expected)) {
      throw new ValidationError(`Requested ${attribute} variant is no longer selected`, "identity_drift");
    }
  }
}

function normalize(input: string): string {
  return input.toLowerCase().normalize("NFKC").replace(/[^a-z0-9]+/g, " ").trim();
}

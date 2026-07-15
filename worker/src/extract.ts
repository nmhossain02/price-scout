import type { Page } from "@browserbasehq/stagehand";
import type {
  ExtractionStrategy,
  MonitorPlanV1,
  Observation,
  SupportedCurrency,
} from "./contracts.js";
import { fingerprint, parsePrice } from "./validation.js";

type JsonLdProduct = Record<string, unknown>;

export async function extractObservation(
  page: Page,
  plan: MonitorPlanV1,
): Promise<Observation> {
  let jsonLd: JsonLdProduct | undefined;
  const loadJsonLd = async () => (jsonLd ??= await readProductJsonLd(page));
  const readFirst = async (strategies: ExtractionStrategy[] | undefined, field: string) => {
    if (!strategies?.length) return undefined;
    const errors: string[] = [];
    for (const strategy of strategies) {
      try {
        const value = await readStrategy(page, strategy, loadJsonLd);
        if (value.trim()) return value.trim();
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(`No ${field} extractor succeeded: ${errors.join("; ")}`);
  };

  const title = await readFirst(plan.extractors.title, "title");
  const rawPrice = await readFirst(plan.extractors.price, "price");
  const availabilityRaw = await readFirst(plan.extractors.availability, "availability");
  if (!title || !rawPrice || !availabilityRaw) throw new Error("Required extraction returned no value");
  const sku = await readFirst(plan.extractors.sku, "sku");
  const currencyRaw = await readFirst(plan.extractors.currency, "currency");
  const parsedPrice = parsePrice(rawPrice);
  const currency = normalizeCurrency(currencyRaw ?? parsedPrice.currency ?? plan.expectedCurrency);

  const selectedVariant: Record<string, string> = {};
  for (const strategy of plan.extractors.selectedVariant) {
    if (!("attribute" in strategy) || !strategy.attribute) continue;
    try {
      const value = await readStrategy(page, strategy, loadJsonLd);
      if (value.trim()) selectedVariant[strategy.attribute] = value.trim();
    } catch {
      // Missing one strategy is handled by identity validation, after all evidence is read.
    }
  }

  return {
    title,
    ...(sku ? { sku } : {}),
    priceMinor: parsedPrice.priceMinor,
    currency,
    inStock: parseAvailability(availabilityRaw),
    availabilityRaw,
    selectedVariant,
    rawPrice,
    identityFingerprint: fingerprint(title, sku),
  };
}

async function readStrategy(
  page: Page,
  strategy: ExtractionStrategy,
  loadJsonLd: () => Promise<JsonLdProduct | undefined>,
): Promise<string> {
  if (strategy.kind === "xpathText") return page.locator(strategy.selector).first().innerText();
  if (strategy.kind === "inputValue") return page.locator(strategy.selector).first().inputValue();
  const product = await loadJsonLd();
  if (!product) throw new Error("No Product JSON-LD was found");
  return jsonLdField(product, strategy.field);
}

async function readProductJsonLd(page: Page): Promise<JsonLdProduct | undefined> {
  const scripts = page.locator("script[type='application/ld+json']");
  const count = Math.min(await scripts.count(), 20);
  for (let index = 0; index < count; index += 1) {
    const raw = await scripts.nth(index).textContent().catch(() => "");
    if (!raw || raw.length > 1_000_000) continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      const product = findProduct(parsed);
      if (product) return product;
    } catch {
      // Malformed third-party JSON-LD is common; another strategy may succeed.
    }
  }
  return undefined;
}

function findProduct(value: unknown): JsonLdProduct | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const product = findProduct(item);
      if (product) return product;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const object = value as JsonLdProduct;
  const type = object["@type"];
  if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) return object;
  return findProduct(object["@graph"]);
}

function jsonLdField(product: JsonLdProduct, field: string): string {
  const offersValue = product.offers;
  const offers = Array.isArray(offersValue) ? offersValue[0] : offersValue;
  const offer = offers && typeof offers === "object" ? (offers as JsonLdProduct) : {};
  const map: Record<string, unknown> = {
    title: product.name,
    sku: product.sku,
    price: offer.price ?? offer.lowPrice,
    currency: offer.priceCurrency,
    availability: offer.availability,
  };
  const value = map[field];
  if (value === undefined || value === null) throw new Error(`JSON-LD has no ${field}`);
  return String(value);
}

function parseAvailability(raw: string): boolean {
  const value = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (/(outofstock|soldout|unavailable|preorder|backorder)/.test(value)) return false;
  if (/(instock|available|addtocart)/.test(value)) return true;
  throw new Error(`Unrecognized availability value: ${raw}`);
}

function normalizeCurrency(raw: string): SupportedCurrency {
  const value = raw.trim().toUpperCase();
  const aliases: Readonly<Record<string, SupportedCurrency>> = {
    "$": "USD",
    "US$": "USD",
    "€": "EUR",
    "£": "GBP",
    "C$": "CAD",
    "A$": "AUD",
  };
  const supported = new Set<SupportedCurrency>(["USD", "CAD", "EUR", "GBP", "AUD"]);
  const code = value.match(/^([A-Z]{3})$/)?.[1];
  const currency = aliases[value] ?? (code && supported.has(code as SupportedCurrency)
    ? code as SupportedCurrency
    : undefined);
  if (!currency) throw new Error(`Unsupported currency: ${raw}`);
  return currency;
}

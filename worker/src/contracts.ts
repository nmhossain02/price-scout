import { z } from "zod";

export const supportedCurrencySchema = z.enum(["USD", "CAD", "EUR", "GBP", "AUD"]);
export type SupportedCurrency = z.infer<typeof supportedCurrencySchema>;

export const actionSchema = z.object({
  selector: z.string().min(1),
  description: z.string().min(1),
  method: z.string().optional(),
  arguments: z.array(z.string()).optional(),
});

export type CachedAction = z.infer<typeof actionSchema>;

export const extractionStrategySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("xpathText"),
    selector: z.string().startsWith("xpath="),
    attribute: z.string().optional(),
  }),
  z.object({
    kind: z.literal("inputValue"),
    selector: z.string().startsWith("xpath="),
    attribute: z.string().optional(),
  }),
  z.object({
    kind: z.literal("jsonLd"),
    field: z.enum(["title", "sku", "price", "currency", "availability"]),
  }),
]);

export type ExtractionStrategy = z.infer<typeof extractionStrategySchema>;

const strategyList = z.array(extractionStrategySchema).min(1);

export const monitorPlanV1Schema = z.object({
  schemaVersion: z.literal(1),
  stagehandVersion: z.literal("3.7.0"),
  canonicalUrl: z.string().url(),
  identity: z.object({
    title: z.string().min(1),
    brand: z.string().optional(),
    sku: z.string().optional(),
    fingerprint: z.string().min(8),
    requestedVariant: z.record(z.string(), z.string()),
  }),
  preparationSteps: z.array(
    z.object({
      purpose: z.enum(["consent", "variant", "expand"]),
      instruction: z.string().min(1),
      action: actionSchema,
    }),
  ),
  extractors: z.object({
    title: strategyList,
    price: strategyList,
    currency: strategyList.optional(),
    availability: strategyList,
    selectedVariant: z.array(extractionStrategySchema),
    sku: strategyList.optional(),
  }),
  expectedCurrency: supportedCurrencySchema,
  validatorVersion: z.literal(1),
});

export type MonitorPlanV1 = z.infer<typeof monitorPlanV1Schema>;

export const monitorConditionSchema = z.object({
  maxPriceMinor: z.number().int().positive().optional(),
  priceBelowMinor: z.number().int().positive().optional(),
  currency: supportedCurrencySchema.optional(),
  requireInStock: z.boolean().default(true),
  requestedVariant: z.record(z.string(), z.string()).default({}),
});

export type MonitorCondition = z.infer<typeof monitorConditionSchema>;

export const executionInputSchema = z.object({
  execution: z.object({
    id: z.string().min(1),
    kind: z.enum(["compile", "check", "repair"]),
    state: z.enum(["queued", "running", "succeeded", "failed", "blocked", "needs_review"]).default("running"),
    attempt: z.number().int().positive().default(1),
    failedGeneration: z.number().int().nonnegative().optional(),
  }),
  monitor: z.object({
    id: z.string().min(1),
    url: z.string().url(),
    intent: z.string().min(1),
    condition: monitorConditionSchema.optional(),
  }),
  revision: z
    .object({
      id: z.string().optional(),
      generation: z.number().int().nonnegative(),
      plan: monitorPlanV1Schema,
    })
    .optional(),
  compilerMode: z.enum(["auto", "scripted", "live"]).default("auto"),
});

export type ExecutionInput = z.infer<typeof executionInputSchema>;

export const queueJobSchema = z.object({
  executionId: z.string().min(1),
  traceparent: z.string().max(512).optional(),
});

export interface Observation {
  title: string;
  sku?: string;
  priceMinor: number;
  currency: SupportedCurrency;
  inStock: boolean;
  availabilityRaw: string;
  selectedVariant: Record<string, string>;
  rawPrice: string;
  identityFingerprint: string;
}

export interface ArtifactRef {
  kind: "screenshot" | "snapshot";
  storageKey: string;
  contentType: "image/png" | "text/plain";
  sizeBytes: number;
  sha256: string;
}

export type FailureClassification =
  | "transient_infrastructure"
  | "blocked"
  | "rate_limited"
  | "stale_action"
  | "stale_extractor"
  | "identity_drift"
  | "ambiguous_value"
  | "invalid_input";

export interface ExecutionResult {
  status: "succeeded" | "failed" | "needs_review";
  kind: "compile" | "check" | "repair";
  executionId: string;
  monitorId: string;
  generation?: number;
  candidatePlan?: MonitorPlanV1;
  observation?: Observation;
  artifacts: ArtifactRef[];
  modelCallCount: number;
  browserProvider: "LOCAL" | "BROWSERBASE";
  browserbaseSessionId?: string;
  traceId?: string;
  cacheStatus?: "HIT" | "MISS";
  repairSource?: "scripted" | "stagehand";
  requiresConfirmation?: boolean;
  failure?: { classification: FailureClassification; message: string };
  timingsMs: Record<string, number>;
}

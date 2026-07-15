import type { WorkerConfig } from "./config.js";
import {
  executionInputSchema,
  type ExecutionInput,
  type ExecutionResult,
} from "./contracts.js";

export class ControlPlaneClient {
  constructor(private readonly config: WorkerConfig) {}

  async input(executionId: string, signal?: AbortSignal): Promise<ExecutionInput> {
    const requestSignal = withTimeout(signal, this.config.CONTROL_PLANE_TIMEOUT_MS);
    const response = await fetch(
      `${this.config.INTERNAL_API_URL}/internal/v1/executions/${encodeURIComponent(executionId)}/input`,
      { headers: this.headers(), signal: requestSignal },
    );
    if (!response.ok) throw new Error(`Control plane input failed (${response.status}): ${await response.text()}`);
    const raw = (await response.json()) as Record<string, any>;
    const terminal = ["succeeded", "failed", "blocked", "needs_review"].includes(raw.execution?.state);
    const revision = raw.revision && !terminal
      ? {
          id: raw.revision.id,
          generation: raw.revision.generation,
          plan: raw.plan ?? raw.revision.plan,
        }
      : undefined;
    const normalized = {
      execution: {
        id: raw.execution?.id,
        kind: raw.execution?.kind,
        state: raw.execution?.state ?? "running",
        attempt: raw.execution?.attempt || 1,
        failedGeneration: raw.execution?.requestedGeneration ?? undefined,
      },
      monitor: {
        id: raw.monitor?.id,
        url: raw.monitor?.url,
        intent: raw.monitor?.intent,
        ...(!terminal && raw.monitor?.condition && typeof raw.monitor.condition === "object"
          ? { condition: raw.monitor.condition }
          : {}),
      },
      ...(revision ? { revision } : {}),
      compilerMode: raw.compilerMode ?? this.config.INFERENCE_MODE,
    };
    return executionInputSchema.parse(normalized);
  }

  async result(executionId: string, result: ExecutionResult, signal?: AbortSignal): Promise<void> {
    const requestSignal = withTimeout(signal, this.config.CONTROL_PLANE_TIMEOUT_MS);
    const body = {
      status: result.status,
      ...(result.failure
        ? {
            failureClassification: result.failure.classification,
            error: result.failure.message,
          }
        : {}),
      provider: result.browserProvider.toLowerCase(),
      ...(result.traceId ? { traceId: result.traceId } : {}),
      ...(result.browserbaseSessionId
        ? { browserSessionUrl: `https://www.browserbase.com/sessions/${result.browserbaseSessionId}` }
        : {}),
      ...(result.candidatePlan ? { plan: result.candidatePlan } : {}),
      ...(result.observation
        ? {
            observation: {
              priceMinor: result.observation.priceMinor,
              currency: result.observation.currency,
              inStock: result.observation.inStock,
              title: result.observation.title,
              rawText: result.observation.rawPrice,
              identity: {
                fingerprint: result.observation.identityFingerprint,
                sku: result.observation.sku,
                selectedVariant: result.observation.selectedVariant,
              },
              verificationState: result.status === "needs_review" ? "review_required" : "verified",
            },
          }
        : {}),
      artifacts: result.artifacts,
      autoPromote: result.kind === "repair" && result.status === "succeeded",
      diagnostics: {
        modelCallCount: result.modelCallCount,
        cacheStatus: result.cacheStatus,
        repairSource: result.repairSource,
        timingsMs: result.timingsMs,
      },
    };
    const response = await fetch(
      `${this.config.INTERNAL_API_URL}/internal/v1/executions/${encodeURIComponent(executionId)}/result`,
      {
        method: "POST",
        headers: {
          ...this.headers(),
          "Content-Type": "application/json",
          "Idempotency-Key": executionId,
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      },
    );
    if (!response.ok) throw new Error(`Control plane result failed (${response.status}): ${await response.text()}`);
  }

  private headers(): Record<string, string> {
    return { "X-Worker-Token": this.config.WORKER_TOKEN };
  }
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

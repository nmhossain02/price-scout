import type { Page } from "@browserbasehq/stagehand";
import { captureEvidence } from "./artifacts.js";
import { BrowserRun } from "./browser.js";
import { compileMonitor } from "./compiler.js";
import type { WorkerConfig } from "./config.js";
import {
  monitorPlanV1Schema,
  type ExecutionInput,
  type ExecutionResult,
  type FailureClassification,
  type MonitorPlanV1,
  type Observation,
} from "./contracts.js";
import { extractObservation } from "./extract.js";
import {
  assertSameOrigin,
  replaySafeAction,
  SafetyError,
  StaleActionError,
  validateTargetUrl,
} from "./safety.js";
import { ValidationError, validateObservation } from "./validation.js";

export async function executeJob(
  input: ExecutionInput,
  config: WorkerConfig,
  signal?: AbortSignal,
): Promise<ExecutionResult> {
  const started = performance.now();
  const timingsMs: Record<string, number> = {};
  let run: BrowserRun | undefined;
  let page: Page | undefined;
  const closeOnAbort = () => {
    void run?.close();
  };
  signal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    throwIfAborted(signal);
    const target = await timed("urlValidation", timingsMs, () =>
      validateTargetUrl(input.monitor.url, config.allowedPrivateHosts),
    );
    throwIfAborted(signal);
    const scripted =
      input.compilerMode === "scripted" ||
      (input.compilerMode === "auto" && target.origin === new URL(config.FIXTURE_ORIGIN).origin);
    const needsModel = !scripted && (input.execution.kind === "compile" || input.execution.kind === "repair");
    run = new BrowserRun(config, {
      selfHeal: input.execution.kind === "repair",
      needsModel,
      executionId: input.execution.id,
    });
    throwIfAborted(signal);
    const initializedPage = await timed("browserInit", timingsMs, () => run!.init(target.hostname));
    page = initializedPage;
    throwIfAborted(signal);

    if (input.execution.kind === "compile") {
      const outcome = await timed("compile", timingsMs, () =>
        compileMonitor(run!, initializedPage, input, target, config.FIXTURE_ORIGIN, config),
      );
      const artifacts = await timed("evidence", timingsMs, () =>
        captureEvidence(initializedPage, config.ARTIFACT_DIR, input.execution.id),
      );
      timingsMs.total = elapsed(started);
      return {
        status: "succeeded",
        kind: "compile",
        executionId: input.execution.id,
        monitorId: input.monitor.id,
        candidatePlan: outcome.plan,
        observation: outcome.observation,
        artifacts,
        modelCallCount: outcome.modelCallCount,
        browserProvider: run.provider,
        ...(run.sessionId ? { browserbaseSessionId: run.sessionId } : {}),
        cacheStatus: "MISS",
        requiresConfirmation: true,
        timingsMs,
      };
    }

    const revision = requireRevision(input);
    if (input.execution.kind === "check") {
      const observation = await timed("warmCheck", timingsMs, () =>
        warmCheck(run!, initializedPage, revision.plan, target, config.NAVIGATION_TIMEOUT_MS),
      );
      const artifacts = await timed("evidence", timingsMs, () =>
        captureEvidence(initializedPage, config.ARTIFACT_DIR, input.execution.id),
      );
      timingsMs.total = elapsed(started);
      return {
        status: "succeeded",
        kind: "check",
        executionId: input.execution.id,
        monitorId: input.monitor.id,
        generation: revision.generation,
        observation,
        artifacts,
        modelCallCount: 0,
        browserProvider: run.provider,
        ...(run.sessionId ? { browserbaseSessionId: run.sessionId } : {}),
        cacheStatus: "HIT",
        timingsMs,
      };
    }

    const outcome = scripted
      ? await timed("scriptedRepair", timingsMs, () =>
          compileMonitor(run!, initializedPage, input, target, config.FIXTURE_ORIGIN, config),
        )
      : await timed("stagehandRepair", timingsMs, () =>
          repairLive(run!, initializedPage, input, revision.plan, target, config),
        );
    const freshObservation = await timed("freshValidation", timingsMs, () =>
      validateRepairFresh(config, input, target, outcome.plan, signal),
    );
    assertObservationsAgree(outcome.observation, freshObservation);
    const artifacts = await timed("evidence", timingsMs, () =>
      captureEvidence(initializedPage, config.ARTIFACT_DIR, input.execution.id),
    );
    timingsMs.total = elapsed(started);
    return {
      status: "succeeded",
      kind: "repair",
      executionId: input.execution.id,
      monitorId: input.monitor.id,
      generation: revision.generation + 1,
      candidatePlan: outcome.plan,
      artifacts,
      modelCallCount: outcome.modelCallCount,
      browserProvider: run.provider,
      ...(run.sessionId ? { browserbaseSessionId: run.sessionId } : {}),
      cacheStatus: "MISS",
      repairSource: outcome.source,
      requiresConfirmation: false,
      timingsMs,
    };
  } catch (error) {
    const terminalError = signal?.aborted ? abortReason(signal) : error;
    let artifacts: Awaited<ReturnType<typeof captureEvidence>> = [];
    if (page && !signal?.aborted) {
      try {
        artifacts = await timed("failureEvidence", timingsMs, () =>
          captureEvidence(page!, config.ARTIFACT_DIR, input.execution.id),
        );
      } catch {
        // Evidence is best effort. Never replace the browser/extraction failure
        // that determines the execution's terminal state and repair policy.
      }
    }
    timingsMs.total = elapsed(started);
    return {
      status: terminalError instanceof ValidationError ? "needs_review" : "failed",
      kind: input.execution.kind,
      executionId: input.execution.id,
      monitorId: input.monitor.id,
      artifacts,
      modelCallCount: metric(run, "actSelfHealCount"),
      browserProvider: config.BROWSER_PROVIDER,
      ...(run?.sessionId ? { browserbaseSessionId: run.sessionId } : {}),
      failure: {
        classification: classifyFailure(terminalError),
        message: safeError(terminalError),
      },
      timingsMs,
    };
  } finally {
    signal?.removeEventListener("abort", closeOnAbort);
    await run?.close();
  }
}

async function warmCheck(
  run: BrowserRun,
  page: Page,
  plan: MonitorPlanV1,
  target: URL,
  navigationTimeoutMs: number,
): Promise<Observation> {
  await page.goto(plan.canonicalUrl, { waitUntil: "domcontentloaded", timeoutMs: navigationTimeoutMs });
  assertSameOrigin(page.url(), target);
  for (const step of plan.preparationSteps) {
    await replaySafeAction(run, page, step.action, target);
  }
  const observation = await extractObservation(page, plan);
  validateObservation(observation, plan);
  return observation;
}

async function repairLive(
  run: BrowserRun,
  page: Page,
  input: ExecutionInput,
  oldPlan: MonitorPlanV1,
  target: URL,
  config: WorkerConfig,
) {
  const candidate = structuredClone(oldPlan);
  await page.goto(candidate.canonicalUrl, {
    waitUntil: "domcontentloaded",
    timeoutMs: config.NAVIGATION_TIMEOUT_MS,
  });
  assertSameOrigin(page.url(), target);
  try {
    for (const step of candidate.preparationSteps) {
      const healed = await replaySafeAction(run, page, step.action, target);
      const replacement = healed.at(-1);
      if (replacement) {
        step.action = replacement;
      }
    }
    const first = await extractObservation(page, candidate);
    validateObservation(first, candidate);
    return {
      plan: candidate,
      observation: first,
      modelCallCount: Math.max(1, metric(run, "actSelfHealCount")),
      source: "stagehand" as const,
    };
  } catch (error) {
    if (error instanceof ValidationError || error instanceof SafetyError) throw error;
    return compileMonitor(run, page, input, target, config.FIXTURE_ORIGIN, config);
  }
}

async function validateRepairFresh(
  config: WorkerConfig,
  input: ExecutionInput,
  target: URL,
  plan: MonitorPlanV1,
  signal?: AbortSignal,
): Promise<Observation> {
  const validator = new BrowserRun(config, {
    selfHeal: false,
    needsModel: false,
    executionId: `${input.execution.id}-validator`,
  });
  const closeOnAbort = () => {
    void validator.close();
  };
  signal?.addEventListener("abort", closeOnAbort, { once: true });
  try {
    throwIfAborted(signal);
    const page = await validator.init(target.hostname);
    throwIfAborted(signal);
    const observation = await warmCheck(
      validator,
      page,
      plan,
      target,
      config.NAVIGATION_TIMEOUT_MS,
    );
    throwIfAborted(signal);
    return observation;
  } finally {
    signal?.removeEventListener("abort", closeOnAbort);
    await validator.close();
  }
}

function assertObservationsAgree(candidate: Observation, fresh: Observation): void {
  const conflict =
    candidate.priceMinor !== fresh.priceMinor ||
    candidate.currency !== fresh.currency ||
    candidate.inStock !== fresh.inStock ||
    candidate.identityFingerprint !== fresh.identityFingerprint ||
    JSON.stringify(candidate.selectedVariant) !== JSON.stringify(fresh.selectedVariant);
  if (conflict) {
    throw new ValidationError(
      "Repair candidate produced conflicting observations in an independent browser session",
      "ambiguous_value",
    );
  }
}

function requireRevision(input: ExecutionInput) {
  if (!input.revision) throw new Error(`${input.execution.kind} execution requires an active monitor revision`);
  return {
    ...input.revision,
    plan: monitorPlanV1Schema.parse(input.revision.plan),
  };
}

function classifyFailure(error: unknown): FailureClassification {
  if (error instanceof SafetyError) return "invalid_input";
  if (error instanceof StaleActionError) return "stale_action";
  if (error instanceof ValidationError) return error.reason;
  const message = safeError(error).toLowerCase();
  if (/429|rate.?limit|retry-after/.test(message)) return "rate_limited";
  if (/403|captcha|access denied|blocked/.test(message)) return "blocked";
  if (/selector|element|xpath|locator|not found/.test(message)) return "stale_action";
  if (/extract|price|availability/.test(message)) return "stale_extractor";
  return "transient_infrastructure";
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 1000);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Execution aborted");
}

async function timed<T>(name: string, timings: Record<string, number>, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    timings[name] = elapsed(started);
  }
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

function metric(run: BrowserRun | undefined, name: string): number {
  if (!run) return 0;
  const value = (run.stagehand.stagehandMetrics as unknown as Record<string, unknown>)[name];
  return typeof value === "number" ? value : 0;
}

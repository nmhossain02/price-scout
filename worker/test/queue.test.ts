import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { ExecutionInput, ExecutionResult } from "../src/contracts.js";
import {
  ensureDurableConsumer,
  executeWithJobTimeout,
  processDelivery,
} from "../src/queue.js";

describe("worker queue delivery", () => {
  it("treats a durable-consumer creation race as success", async () => {
    const missing = Object.assign(new Error("consumer not found"), { code: "404" });
    const exists = Object.assign(new Error("consumer already exists"), { code: "400" });
    const info = vi.fn().mockRejectedValue(missing);
    const add = vi.fn().mockRejectedValue(exists);
    const update = vi.fn().mockResolvedValue({});
    const js = {
      jetstreamManager: async () => ({ consumers: { info, add, update } }),
    };

    await expect(ensureDurableConsumer(js as never, config())).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
  });

  it("acknowledges a redelivered terminal execution without running a browser job", async () => {
    const message = fakeMessage("exec-terminal");
    const api = {
      input: vi.fn().mockResolvedValue(input("succeeded")),
      result: vi.fn(),
    };
    const executor = vi.fn();
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    await processDelivery(message.value as never, config(), api, executor);

    expect(executor).not.toHaveBeenCalled();
    expect(api.result).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.nak).not.toHaveBeenCalled();
  });

  it("terminates a permanently invalid internal work message", async () => {
    const message = fakeMessage("");
    message.value.json = () => ({ wrong: "shape" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await processDelivery(message.value as never, config(), {
      input: vi.fn(),
      result: vi.fn(),
    });

    expect(message.term).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.nak).not.toHaveBeenCalled();
  });

  it("terminates malformed JSON without crashing the worker loop", async () => {
    const message = fakeMessage("");
    message.value.json = () => {
      throw new SyntaxError("bad JSON");
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(processDelivery(message.value as never, config(), {
      input: vi.fn(),
      result: vi.fn(),
    })).resolves.toBeUndefined();

    expect(message.term).toHaveBeenCalledOnce();
    expect(message.nak).not.toHaveBeenCalled();
  });

  it("aborts the injected executor at the configured job deadline", async () => {
    const deadlineConfig = config({ JOB_TIMEOUT_MS: "10" });
    let observedSignal: AbortSignal | undefined;
    const executor = vi.fn(async (
      job: ExecutionInput,
      _config: ReturnType<typeof config>,
      signal?: AbortSignal,
    ): Promise<ExecutionResult> => {
      observedSignal = signal;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return failedResult(job, signal?.reason);
    });

    const result = await executeWithJobTimeout(input("running"), deadlineConfig, executor);

    expect(observedSignal?.aborted).toBe(true);
    expect(result.failure?.message).toContain("Job deadline exceeded");
    expect(executor).toHaveBeenCalledOnce();
  });

  it("propagates a validated W3C trace id into the accepted result", async () => {
    const message = fakeMessage(
      "exec-running",
      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    );
    const job = input("running");
    const api = {
      input: vi.fn().mockResolvedValue(job),
      result: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    await processDelivery(message.value as never, config(), api, async () => ({
      ...failedResult(job, new Error("blocked")),
      failure: { classification: "blocked", message: "blocked" },
    }));

    expect(api.result.mock.calls[0]?.[1]).toMatchObject({
      traceId: "0123456789abcdef0123456789abcdef",
    });
    expect(message.ack).toHaveBeenCalledOnce();
  });
});

function config(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    INTERNAL_API_URL: "http://api:8080",
    WORKER_TOKEN: "secret",
    ...overrides,
  });
}

function input(state: ExecutionInput["execution"]["state"]): ExecutionInput {
  return {
    execution: { id: "exec-terminal", kind: "check", state, attempt: 1 },
    monitor: {
      id: "monitor-1",
      url: "https://shop.example/product",
      intent: "track this product",
    },
    compilerMode: "scripted",
  };
}

function failedResult(job: ExecutionInput, error: unknown): ExecutionResult {
  return {
    status: "failed",
    kind: job.execution.kind,
    executionId: job.execution.id,
    monitorId: job.monitor.id,
    artifacts: [],
    modelCallCount: 0,
    browserProvider: "LOCAL",
    failure: {
      classification: "transient_infrastructure",
      message: error instanceof Error ? error.message : String(error),
    },
    timingsMs: { total: 10 },
  };
}

function fakeMessage(executionId: string, traceparent?: string) {
  const ack = vi.fn();
  const nak = vi.fn();
  const term = vi.fn();
  return {
    value: {
      json: () => ({ executionId, ...(traceparent ? { traceparent } : {}) }),
      working: vi.fn(),
      ack,
      nak,
      term,
      info: { redeliveryCount: 1 },
    },
    ack,
    nak,
    term,
  };
}

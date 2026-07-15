import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import type { ExecutionResult, MonitorPlanV1 } from "../src/contracts.js";

const config = loadConfig({
  INTERNAL_API_URL: "http://api:8080",
  WORKER_TOKEN: "secret",
});

afterEach(() => vi.unstubAllGlobals());

describe("control-plane client", () => {
  it("normalizes the control-plane plan envelope", async () => {
    const plan = fixturePlan();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1,
      execution: { id: "exec-1", kind: "check", state: "running", attempt: 1, requestedGeneration: 2 },
      monitor: { id: "monitor-1", url: "https://shop.example/p", intent: "under $100", condition: {} },
      revision: { id: "revision-1", generation: 2, plan },
      plan,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const input = await new ControlPlaneClient(config).input("exec-1");
    expect(input.revision?.generation).toBe(2);
    expect(input.revision?.plan).toEqual(plan);
    expect(input.execution.state).toBe("running");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "X-Worker-Token": "secret" });
  });

  it("normalizes terminal redeliveries without reparsing obsolete plan data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      execution: { id: "exec-terminal", kind: "check", state: "succeeded", attempt: 1 },
      monitor: { id: "monitor-1", url: "https://shop.example/p", intent: "under $100" },
      revision: { id: "old-revision", generation: 1, plan: { incompatible: true } },
      plan: { incompatible: true },
    }), { status: 200 })));

    const input = await new ControlPlaneClient(config).input("exec-terminal");

    expect(input.execution.state).toBe("succeeded");
    expect(input.revision).toBeUndefined();
  });

  it("uses the configured inference mode when the API does not override it", async () => {
    const liveConfig = loadConfig({
      INTERNAL_API_URL: "http://api:8080",
      WORKER_TOKEN: "secret",
      INFERENCE_MODE: "live",
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      execution: { id: "exec-live", kind: "compile", attempt: 1 },
      monitor: { id: "monitor-live", url: "https://shop.example/p", intent: "track this product" },
    }), { status: 200 })));
    const input = await new ControlPlaneClient(liveConfig).input("exec-live");
    expect(input.compilerMode).toBe("live");
  });

  it("bounds a hung control-plane request", async () => {
    const timeoutConfig = loadConfig({
      INTERNAL_API_URL: "http://api:8080",
      WORKER_TOKEN: "secret",
      CONTROL_PLANE_TIMEOUT_MS: "5",
    });
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    ));

    await expect(new ControlPlaneClient(timeoutConfig).input("exec-hung")).rejects.toThrow();
  });

  it("posts the candidate plan, relative artifacts, and verified observation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const plan = fixturePlan();
    const result: ExecutionResult = {
      status: "succeeded",
      kind: "compile",
      executionId: "exec-1",
      monitorId: "monitor-1",
      candidatePlan: plan,
      observation: {
        title: "Atlas Studio Headphones",
        priceMinor: 99_900,
        currency: "USD",
        inStock: true,
        availabilityRaw: "In stock",
        selectedVariant: {},
        rawPrice: "$999.00",
        identityFingerprint: plan.identity.fingerprint,
      },
      artifacts: [{ kind: "screenshot", storageKey: "exec-1/page.png", contentType: "image/png", sha256: "abc", sizeBytes: 100 }],
      modelCallCount: 0,
      browserProvider: "LOCAL",
      traceId: "0123456789abcdef0123456789abcdef",
      timingsMs: { total: 10 },
    };
    await new ControlPlaneClient(config).result("exec-1", result);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.plan).toEqual(plan);
    expect(body.observation.verificationState).toBe("verified");
    expect(body.artifacts[0].storageKey).toBe("exec-1/page.png");
    expect(body.provider).toBe("local");
    expect(body.traceId).toBe("0123456789abcdef0123456789abcdef");
  });
});

function fixturePlan(): MonitorPlanV1 {
  return {
    schemaVersion: 1,
    stagehandVersion: "3.7.0",
    canonicalUrl: "https://shop.example/p",
    identity: { title: "Atlas Studio Headphones", fingerprint: "12345678", requestedVariant: {} },
    preparationSteps: [],
    extractors: {
      title: [{ kind: "xpathText", selector: "xpath=//h1" }],
      price: [{ kind: "xpathText", selector: "xpath=//*[@class='price']" }],
      availability: [{ kind: "xpathText", selector: "xpath=//*[@class='stock']" }],
      selectedVariant: [{ kind: "xpathText", selector: "xpath=//*[@class='variant']", attribute: "color" }],
    },
    expectedCurrency: "USD",
    validatorVersion: 1,
  };
}

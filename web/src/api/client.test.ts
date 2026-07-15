import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./client";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("API response normalization", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts paginated monitor item responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ items: [{ id: "m-1", url: "https://shop.test/item", intent: "under $10", status: "active", createdAt: "2026-01-01T00:00:00Z" }] })));
    const monitors = await api.listMonitors();
    expect(monitors).toHaveLength(1);
    expect(monitors[0]?.id).toBe("m-1");
  });

  it("flattens monitor detail collections", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      monitor: { id: "m-1", url: "https://shop.test/item", intent: "under $10", status: "active", createdAt: "2026-01-01T00:00:00Z" },
      revisions: [{ id: "r-1", generation: 1, createdAt: "2026-01-01T00:00:00Z" }],
      observations: [{ id: "o-1", priceMinor: 999, currency: "USD", observedAt: "2026-01-01T01:00:00Z" }],
      executions: [],
    })));
    const monitor = await api.getMonitor("m-1");
    expect(monitor.revisions?.[0]?.generation).toBe(1);
    expect(monitor.observations?.[0]?.priceMinor).toBe(999);
  });

  it("normalizes queued check execution responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ execution: { id: "exec-42" }, created: true }, 202)));
    await expect(api.runCheck("m-1")).resolves.toEqual({ executionId: "exec-42" });
  });

  it("normalizes diagnostics nested in a stored execution result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      id: "e-1",
      monitorId: "m-1",
      kind: "repair",
      state: "succeeded",
      createdAt: "2026-01-01T00:00:00Z",
      startedAt: "2026-01-01T00:00:01Z",
      completedAt: "2026-01-01T00:00:05Z",
      result: {
        diagnostics: {
          modelCallCount: 2,
          cacheStatus: "MISS",
          repairSource: "stagehand",
          timingsMs: { browserInit: 125, total: 3200, ignored: "not numeric" },
        },
      },
    })));

    const execution = await api.getExecution("e-1");
    expect(execution.durationMs).toBe(4000);
    expect(execution.diagnostics).toEqual({
      modelCallCount: 2,
      cacheStatus: "MISS",
      repairSource: "stagehand",
      timingsMs: { browserInit: 125, total: 3200 },
    });
  });
});

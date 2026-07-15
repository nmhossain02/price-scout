import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixtureServer } from "../../fixture/src/server.js";
import { loadConfig } from "../src/config.js";
import type { ExecutionInput, MonitorPlanV1 } from "../src/contracts.js";
import { executeJob } from "../src/handler.js";
import { executeWithJobTimeout } from "../src/queue.js";

const enabled = process.env.RUN_BROWSER_TESTS === "1";
const suite = enabled ? describe : describe.skip;

suite("deterministic browser lifecycle", () => {
  const server = createFixtureServer({ controlToken: "integration-token" });
  let origin = "";
  let artifactDir = "";
  let planV1: MonitorPlanV1;
  let planV2: MonitorPlanV1;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    artifactDir = await mkdtemp(path.join(tmpdir(), "price-scout-test-"));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(artifactDir, { recursive: true, force: true });
  });

  const config = () =>
    loadConfig({
      BROWSER_PROVIDER: "LOCAL",
      CHROME_EXECUTABLE_PATH: process.env.CHROME_EXECUTABLE_PATH,
      FIXTURE_ORIGIN: origin,
      ALLOWED_PRIVATE_HOSTS: "127.0.0.1",
      ARTIFACT_DIR: artifactDir,
    });

  it("compiles v1 with no model calls", async () => {
    const result = await executeJob(input("compile", "compile-1"), config());
    expect(result.status, result.failure?.message).toBe("succeeded");
    expect(result.modelCallCount).toBe(0);
    expect(result.observation).toMatchObject({ priceMinor: 126_900, currency: "USD", inStock: true });
    expect(result.artifacts.map((item) => item.storageKey)).toEqual([
      "compile-1/page.png",
      "compile-1/snapshot.txt",
    ]);
    await expect(access("/tmp/price-scout-cache/compile-1")).rejects.toThrow();
    planV1 = result.candidatePlan!;
  }, 90_000);

  it("replays the compiled plan without inference", async () => {
    const result = await executeJob(input("check", "check-1", planV1), config());
    expect(result.status, result.failure?.message).toBe("succeeded");
    expect(result.modelCallCount).toBe(0);
    expect(result.cacheStatus).toBe("HIT");
  }, 90_000);

  it("aborts and cleans up a browser run at the job deadline", async () => {
    const deadlineConfig = loadConfig({
      BROWSER_PROVIDER: "LOCAL",
      CHROME_EXECUTABLE_PATH: process.env.CHROME_EXECUTABLE_PATH,
      FIXTURE_ORIGIN: origin,
      ALLOWED_PRIVATE_HOSTS: "127.0.0.1",
      ARTIFACT_DIR: artifactDir,
      JOB_TIMEOUT_MS: "10",
    });
    const result = await executeWithJobTimeout(input("compile", "compile-timeout"), deadlineConfig);

    expect(result.status).toBe("failed");
    expect(result.failure).toMatchObject({ classification: "transient_infrastructure" });
    expect(result.failure?.message).toContain("Job deadline exceeded");
    await expect(access("/tmp/price-scout-cache/compile-timeout")).rejects.toThrow();
  }, 90_000);

  it("fails closed after the redesign, then repairs and reuses v2", async () => {
    await fetch(`${origin}/__control/deploy`, {
      method: "POST",
      headers: { "X-Fixture-Token": "integration-token" },
    });
    const broken = await executeJob(input("check", "check-broken", planV1), config());
    expect(broken.status).toBe("failed");
    expect(broken.failure?.classification).toBe("stale_action");
    expect(broken.artifacts.map((item) => item.storageKey)).toEqual([
      "check-broken/page.png",
      "check-broken/snapshot.txt",
    ]);

    const repaired = await executeJob(input("repair", "repair-1", planV1), config());
    expect(repaired.status, repaired.failure?.message).toBe("succeeded");
    expect(repaired.modelCallCount).toBe(0);
    expect(repaired.repairSource).toBe("scripted");
    expect(repaired.timingsMs.freshValidation).toBeGreaterThan(0);
    await expect(access("/tmp/price-scout-cache/repair-1-validator")).rejects.toThrow();
    planV2 = repaired.candidatePlan!;
    expect(planV2.preparationSteps[0]?.action.selector).toContain("data-variant-group");

    const healed = await executeJob(input("check", "check-healed", planV2), config());
    expect(healed.status, healed.failure?.message).toBe("succeeded");
    expect(healed.observation?.priceMinor).toBe(126_900);
    expect(healed.modelCallCount).toBe(0);
  }, 180_000);

  function input(kind: "compile" | "check" | "repair", id: string, plan?: MonitorPlanV1): ExecutionInput {
    return {
      execution: { id, kind, state: "running", attempt: 1, ...(kind === "repair" ? { failedGeneration: 1 } : {}) },
      monitor: {
        id: "monitor-1",
        url: `${origin}/products/atlas-headphones`,
        intent: "Alert me when the silver 2 TB model is under $1,300",
        condition: {
          maxPriceMinor: 130_000,
          currency: "USD",
          requireInStock: true,
          requestedVariant: { color: "silver", capacity: "2tb" },
        },
      },
      ...(plan ? { revision: { id: "revision-1", generation: 1, plan } } : {}),
      compilerMode: "auto",
    };
  }
});

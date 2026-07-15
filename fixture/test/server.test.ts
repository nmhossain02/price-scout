import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createFixtureServer } from "../src/server.js";

const servers: ReturnType<typeof createFixtureServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function start() {
  const server = createFixtureServer({ controlToken: "test-token" });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("synthetic retailer", () => {
  it("keeps the product URL stable while deploying different selectors", async () => {
    const origin = await start();
    const path = "/products/atlas-headphones";
    const v1 = await (await fetch(origin + path)).text();
    expect(v1).toContain('id="legacy-color-black"');
    expect(v1).toContain('id="current-price"');

    const deploy = await fetch(`${origin}/__control/deploy`, {
      method: "POST",
      headers: { "X-Fixture-Token": "test-token" },
    });
    expect(deploy.status).toBe(200);
    const v2 = await (await fetch(origin + path)).text();
    expect(v2).not.toContain('id="legacy-color-black"');
    expect(v2).toContain('data-variant-group="color"');
    expect(v2).toContain('data-ui="offer-price"');
  });

  it("controls price and stock and resets deterministically", async () => {
    const origin = await start();
    await fetch(`${origin}/__control/price`, {
      method: "POST",
      headers: { "X-Fixture-Token": "test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ priceMinor: 79_900 }),
    });
    await fetch(`${origin}/__control/stock`, {
      method: "POST",
      headers: { "X-Fixture-Token": "test-token", "Content-Type": "application/json" },
      body: JSON.stringify({ inStock: false }),
    });
    const changed = await (await fetch(`${origin}/__control/state`)).json() as { basePriceMinor: number; inStock: boolean };
    expect(changed).toMatchObject({ basePriceMinor: 79_900, inStock: false });

    await fetch(`${origin}/__control/reset`, { method: "POST", headers: { "X-Fixture-Token": "test-token" } });
    const reset = await (await fetch(`${origin}/__control/state`)).json();
    expect(reset).toMatchObject({ version: 1, basePriceMinor: 109_900, inStock: true, deployment: 1 });
  });

  it("requires the control token", async () => {
    const origin = await start();
    const response = await fetch(`${origin}/__control/deploy`, { method: "POST" });
    expect(response.status).toBe(401);
  });
});

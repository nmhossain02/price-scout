import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { Action, Page } from "@browserbasehq/stagehand";
import type { CachedAction } from "./contracts.js";

export class SafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyError";
  }
}

export class StaleActionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StaleActionError";
  }
}

const unsafePorts = new Set(["21", "22", "23", "25", "53", "2375", "2376", "3306", "5432", "6379", "11211"]);
const forbiddenInteraction =
  /\b(?:add to (?:cart|bag|basket)|buy(?: now)?|purchase|checkout|place order|submit payment|pay now|complete order|confirm order|order now|subscribe)\b/i;

export async function validateTargetUrl(
  input: string,
  allowedPrivateHosts: ReadonlySet<string>,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SafetyError("Target URL is invalid");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafetyError("Only HTTP and HTTPS product URLs are supported");
  }
  if (url.username || url.password) {
    throw new SafetyError("Credentials in product URLs are not allowed");
  }
  if (url.port && unsafePorts.has(url.port)) {
    throw new SafetyError(`Port ${url.port} is not allowed`);
  }

  const hostname = url.hostname.toLowerCase();
  const privateException = allowedPrivateHosts.has(hostname);
  if (isIP(hostname)) {
    if (!privateException) throw new SafetyError("IP-literal product URLs are not allowed");
  } else {
    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new SafetyError(`Unable to resolve target host ${hostname}`);
    }
    if (!addresses.length) throw new SafetyError(`Target host ${hostname} has no addresses`);
    if (!privateException && addresses.some(({ address }) => isPrivateAddress(address))) {
      throw new SafetyError("Target resolves to a private or special-use address");
    }
  }

  url.hash = "";
  return url;
}

export function assertSafeAction(action: CachedAction): void {
  const method = (action.method ?? "click").toLowerCase();
  const allowedMethods = new Set(["click", "selectoptionfromdropdown", "scrollto"]);
  if (!allowedMethods.has(method)) {
    throw new SafetyError(`Compiled action method ${method} is not permitted`);
  }
  if (forbiddenInteraction.test(action.description)) {
    throw new SafetyError("Purchase and checkout actions are never permitted");
  }
  if (!action.selector.startsWith("xpath=") && !action.selector.startsWith("css=")) {
    throw new SafetyError("Only XPath and CSS selectors are permitted in cached actions");
  }
}

/**
 * Inspect the concrete element selected by a cached action before replay. A
 * missing selector is deliberately not an error: repair jobs must be allowed
 * to pass stale selectors to Stagehand so its self-heal path can replace them.
 */
export async function assertSafeActionTarget(page: Page, action: CachedAction): Promise<boolean> {
  let evidence: string;
  try {
    const locator = page.locator(action.selector).first();
    if ((await locator.count()) === 0) return false;
    const [innerText, innerHtml] = await Promise.all([locator.innerText(), locator.innerHtml()]);
    evidence = `${action.description}\n${innerText}\n${innerHtml.slice(0, 20_000)}`;
  } catch {
    // Selector corruption and DOM redesigns are expected on the repair path.
    // Stagehand must see the miss in order to infer a replacement action.
    return false;
  }
  if (forbiddenInteraction.test(evidence)) {
    throw new SafetyError("The located action target appears to purchase, order, or subscribe");
  }
  return true;
}

interface ActionReplayer {
  replay(action: CachedAction | Action): Promise<Action[]>;
}

/** Execute one action with checks around both the cached and healed target. */
export async function replaySafeAction(
  run: ActionReplayer,
  page: Page,
  action: CachedAction | Action,
  expectedOrigin: URL,
): Promise<Action[]> {
  assertSafeAction(action);
  const cachedTargetResolved = await assertSafeActionTarget(page, action);
  let executed: Action[];
  try {
    executed = await run.replay(action);
  } catch (error) {
    if (!cachedTargetResolved) {
      throw new StaleActionError(`Cached action target no longer resolves: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    throw error;
  }
  assertSameOrigin(page.url(), expectedOrigin);
  for (const replacement of executed) {
    assertSafeAction(replacement);
    // Stagehand's public direct-action API returns a self-healed replacement
    // only after executing it. Inspect immediately so an unsafe candidate can
    // never be persisted, while same-origin is enforced above.
    await assertSafeActionTarget(page, replacement);
  }
  return executed;
}

export function assertSameOrigin(actual: string, expected: URL): void {
  const actualUrl = new URL(actual);
  if (actualUrl.origin !== expected.origin) {
    throw new SafetyError(`Navigation left the allowed origin (${actualUrl.origin})`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (
    value === "::1" ||
    value === "::" ||
    value.startsWith("fe80:") ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("ff") ||
    value === "2001:db8::" ||
    value.startsWith("2001:db8:")
  ) return true;
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPrivateAddress(mapped);
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some(Number.isNaN)) return false;
  const [a, b, c] = octets as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

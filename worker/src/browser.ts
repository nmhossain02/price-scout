import { rm } from "node:fs/promises";
import {
  LLMClient,
  Stagehand,
  type Action,
  type CreateChatCompletionOptions,
  type LLMParsedResponse,
  type LLMResponse,
  type Page,
} from "@browserbasehq/stagehand";
import type { WorkerConfig } from "./config.js";
import type { CachedAction } from "./contracts.js";

class DeterministicOnlyClient extends LLMClient {
  public type = "scripted" as const;
  public hasVision = false;
  public clientOptions = {};

  constructor() {
    super("price-scout/scripted");
  }

  async createChatCompletion<T>(
    _options: CreateChatCompletionOptions,
  ): Promise<T | LLMParsedResponse<T> | LLMResponse> {
    throw new Error("A model call was attempted in deterministic fixture mode");
  }
}

export interface BrowserRunOptions {
  selfHeal: boolean;
  needsModel: boolean;
  executionId: string;
}

export class BrowserRun {
  readonly stagehand: Stagehand;
  private initialized = false;
  private closing = false;
  private initPromise?: Promise<Page>;
  private readonly cacheDir: string;
  private closePromise?: Promise<void>;

  constructor(
    private readonly config: WorkerConfig,
    options: BrowserRunOptions,
  ) {
    if (options.needsModel && !config.MODEL_API_KEY) {
      throw new Error("MODEL_API_KEY is required for live compile and repair jobs");
    }
    const model = options.needsModel
      ? { modelName: config.MODEL_NAME, apiKey: config.MODEL_API_KEY! }
      : undefined;
    const localBrowserLaunchOptions = {
      headless: true,
      chromiumSandbox: false,
      // Stagehand 3.7 exposes `chromiumSandbox`, but its V3 local launcher does
      // not currently translate that option into Chromium's command-line
      // flags. Containers run as an unprivileged user without a setuid
      // sandbox, so pass the flag explicitly as well.
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-first-run"],
      viewport: { width: 1440, height: 1000 },
      ...(config.CHROME_EXECUTABLE_PATH
        ? { executablePath: config.CHROME_EXECUTABLE_PATH }
        : {}),
    };

    const browserbaseCredentials = config.BROWSER_PROVIDER === "BROWSERBASE"
      ? {
          ...(config.BROWSERBASE_API_KEY ? { apiKey: config.BROWSERBASE_API_KEY } : {}),
          ...(config.BROWSERBASE_PROJECT_ID ? { projectId: config.BROWSERBASE_PROJECT_ID } : {}),
        }
      : {};
    this.cacheDir = `/tmp/price-scout-cache/${safeSegment(options.executionId)}`;
    this.stagehand = new Stagehand({
      env: config.BROWSER_PROVIDER,
      ...(config.BROWSER_PROVIDER === "BROWSERBASE"
        ? browserbaseCredentials
        : { localBrowserLaunchOptions }),
      ...(model ? { model } : { llmClient: new DeterministicOnlyClient() }),
      selfHeal: options.selfHeal,
      disableAPI: true,
      serverCache: false,
      cacheDir: this.cacheDir,
      verbose: 0,
      disablePino: true,
    });
  }

  async init(allowedHost: string): Promise<Page> {
    if (this.closing) throw new Error("Browser run is already closing");
    this.initialized = true;
    this.initPromise = this.initialize(allowedHost);
    return this.initPromise;
  }

  private async initialize(allowedHost: string): Promise<Page> {
    await this.stagehand.init();
    if (this.closing) {
      await this.stagehand.close().catch(() => undefined);
      throw new Error("Browser run was aborted during initialization");
    }
    // Stagehand rejects single-label hosts (for example the `fixture` service
    // name used by Compose and Kubernetes) as domain-policy patterns. Public
    // hosts still get defense-in-depth here; fixture traffic remains bounded
    // by URL validation and same-origin checks in the worker.
    if (allowedHost.includes(".")) {
      await this.stagehand.context.setDomainPolicy({
        allowedDomains: [allowedHost, `*.${allowedHost}`],
      });
    }
    const existing = this.stagehand.context.pages()[0];
    return existing ?? (await this.stagehand.context.newPage());
  }

  async replay(action: CachedAction | Action): Promise<Action[]> {
    const publicAction: Action = {
      selector: action.selector,
      description: action.description,
      ...(action.method ? { method: action.method } : {}),
      ...(action.arguments ? { arguments: action.arguments } : {}),
    };
    const result = await this.stagehand.act(publicAction);
    if (!result.success) throw new Error(result.message || "Cached action failed");
    return result.actions;
  }

  get provider(): "LOCAL" | "BROWSERBASE" {
    return this.config.BROWSER_PROVIDER;
  }

  get sessionId(): string | undefined {
    return this.stagehand.browserbaseSessionID;
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closing = true;
    try {
      if (this.initialized) {
        // First close interrupts in-flight CDP work. Waiting for initialization
        // and closing once more prevents a late launcher from escaping cleanup.
        await this.stagehand.close().catch(() => undefined);
        await this.initPromise?.catch(() => undefined);
        await this.stagehand.close().catch(() => undefined);
      }
    } finally {
      await rm(this.cacheDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

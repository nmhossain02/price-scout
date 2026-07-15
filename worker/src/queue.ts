import {
  AckPolicy,
  DeliverPolicy,
  ReplayPolicy,
  connect,
  nanos,
  type Consumer,
  type JetStreamClient,
  type JsMsg,
  type NatsConnection,
} from "nats";
import { ControlPlaneClient } from "./api.js";
import type { WorkerConfig } from "./config.js";
import {
  queueJobSchema,
  type ExecutionInput,
  type ExecutionResult,
} from "./contracts.js";
import { executeJob } from "./handler.js";

const stream = "SCOUT_WORK";
const terminalExecutionStates = new Set(["succeeded", "failed", "blocked", "needs_review"]);

interface WorkerApi {
  input(executionId: string, signal?: AbortSignal): Promise<ExecutionInput>;
  result(executionId: string, result: ExecutionResult, signal?: AbortSignal): Promise<void>;
}

export type JobExecutor = (
  input: ExecutionInput,
  config: WorkerConfig,
  signal?: AbortSignal,
) => Promise<ExecutionResult>;

export class WorkerQueue {
  private connection?: NatsConnection;
  private consumer?: Consumer;
  private stopping = false;

  constructor(
    private readonly config: WorkerConfig,
    private readonly api: WorkerApi = new ControlPlaneClient(config),
    private readonly executor: JobExecutor = executeJob,
  ) {}

  async run(): Promise<void> {
    this.connection = await connect({
      servers: this.config.NATS_URL,
      name: `price-scout-worker-${process.pid}`,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 1_000,
    });
    const js = this.connection.jetstream();
    await ensureDurableConsumer(js, this.config);
    this.consumer = await js.consumers.get(stream, this.config.WORKER_QUEUE);
    log("info", "worker ready", { queue: this.config.WORKER_QUEUE, provider: this.config.BROWSER_PROVIDER });

    // Pull exactly one message when this process is ready to start it. A
    // continuous consume() iterator prefetches (100 by default), which can pin
    // un-heartbeated jobs to one replica and starve the rest of the pool.
    while (!this.stopping) {
      let message: JsMsg | null;
      try {
        message = await this.consumer.next({ expires: 5_000 });
      } catch (error) {
        if (this.stopping) break;
        throw error;
      }
      if (!message) continue;
      if (this.stopping) {
        message.nak(1_000);
        break;
      }
      await processDelivery(message, this.config, this.api, this.executor);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // Draining/closing the connection interrupts an outstanding next() call;
    // its finite expiry is a second bound for graceful shutdown.
    await this.connection?.drain();
  }
}

export async function processDelivery(
  message: JsMsg,
  config: WorkerConfig,
  api: WorkerApi,
  executor: JobExecutor = executeJob,
): Promise<void> {
  let heartbeat: NodeJS.Timeout | undefined;
  let raw: unknown;
  try {
    raw = message.json();
  } catch {
    message.term("invalid price-scout work-message JSON");
    log("error", "malformed work message terminated", {});
    return;
  }
  const parsed = queueJobSchema.safeParse(raw);
  if (!parsed.success) {
    // Work messages are emitted by our own outbox. A schema-invalid message is
    // permanent poison, not a transport outage worth retrying forever.
    message.term("invalid price-scout work-message schema");
    log("error", "invalid work message terminated", {});
    return;
  }
  try {
    const payload = parsed.data;
    heartbeat = setInterval(() => message.working(), 15_000);
    heartbeat.unref();
    const input = await api.input(payload.executionId);
    if (terminalExecutionStates.has(input.execution.state)) {
      message.ack();
      log("info", "terminal duplicate acknowledged", {
        executionId: payload.executionId,
        state: input.execution.state,
      });
      return;
    }
    const executionResult = await executeWithJobTimeout(input, config, executor);
    const traceId = traceIdFromTraceparent(payload.traceparent);
    const result = traceId ? { ...executionResult, traceId } : executionResult;
    await api.result(payload.executionId, result);
    message.ack();
    log("info", "execution completed", {
      executionId: payload.executionId,
      kind: input.execution.kind,
      status: result.status,
      totalMs: result.timingsMs.total,
      ...(traceId ? { traceId } : {}),
    });
  } catch (error) {
    message.nak(backoff(message.info.redeliveryCount));
    log("error", "execution delivery failed", {
      error: error instanceof Error ? error.message : String(error),
      redeliveryCount: message.info.redeliveryCount,
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

export async function executeWithJobTimeout(
  input: ExecutionInput,
  config: WorkerConfig,
  executor: JobExecutor = executeJob,
): Promise<ExecutionResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error(`Job deadline exceeded after ${config.JOB_TIMEOUT_MS}ms`)),
    config.JOB_TIMEOUT_MS,
  );
  timeout.unref();
  try {
    // Do not use Promise.race here: executeJob responds to abort by closing its
    // active Chromium/Browserbase session before it settles.
    return await executor(input, config, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

export async function ensureDurableConsumer(js: JetStreamClient, config: WorkerConfig): Promise<void> {
  const manager = await js.jetstreamManager();
  const mutableConfig = {
    ack_wait: nanos(90_000),
    max_deliver: -1,
    max_ack_pending: config.WORKER_MAX_IN_FLIGHT,
  };
  try {
    await manager.consumers.info(stream, config.WORKER_QUEUE);
    await manager.consumers.update(stream, config.WORKER_QUEUE, mutableConfig);
    return;
  } catch (error) {
    if (!isConsumerMissing(error)) throw error;
  }

  try {
    await manager.consumers.add(stream, {
      durable_name: config.WORKER_QUEUE,
      name: config.WORKER_QUEUE,
      filter_subject: "scout.monitor.*",
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      replay_policy: ReplayPolicy.Instant,
      ...mutableConfig,
      // Transport/control-plane failures are retried without a delivery cap;
      // schema-invalid internally produced messages are terminated above.
      // This is a shared consumer-wide ceiling. Each process still pulls only
      // one job at a time, allowing replicas to work concurrently.
    });
  } catch (error) {
    // Several replicas can all observe the initial 404. The replica that loses
    // the add race should bind to the durable created by the winner.
    if (!isConsumerAlreadyExists(error)) throw error;
    await manager.consumers.update(stream, config.WORKER_QUEUE, mutableConfig);
  }
}

function isConsumerMissing(error: unknown): boolean {
  const code = String((error as { code?: unknown }).code ?? "");
  return code === "404" || /consumer not found/i.test(String(error));
}

function isConsumerAlreadyExists(error: unknown): boolean {
  const details = `${String((error as { code?: unknown }).code ?? "")} ${String(error)}`;
  return /consumer.*(?:already exists|name already in use)|(?:already exists|name already in use).*consumer/i.test(details);
}

function backoff(redeliveryCount: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(redeliveryCount, 6));
}

function traceIdFromTraceparent(traceparent: string | undefined): string | undefined {
  const match = traceparent?.match(
    /^00-(?!0{32})([0-9a-f]{32})-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/,
  );
  return match?.[1];
}

function log(level: "info" | "error", message: string, details: Record<string, unknown>): void {
  console[level](JSON.stringify({ timestamp: new Date().toISOString(), level, service: "worker", message, ...details }));
}

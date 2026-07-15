export type MonitorStatus =
  | "compiling"
  | "awaiting_confirmation"
  | "active"
  | "needs_review"
  | "paused"
  | "blocked";

export type ExecutionState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "needs_review"
  | "cancelled";

export interface PriceCondition {
  priceBelowMinor?: number;
  currency?: string;
  requireInStock: boolean;
  requestedVariant: Record<string, string>;
}

export interface Observation {
  id: string;
  executionId?: string;
  priceMinor?: number;
  currency?: string;
  inStock?: boolean;
  rawText?: string;
  title?: string;
  selectedVariant?: Record<string, string>;
  verificationState?: "verified" | "review_required" | "failed" | "blocked";
  observedAt: string;
  screenshotUrl?: string;
}

export interface MonitorRevision {
  id: string;
  generation: number;
  source?: "compile" | "repair";
  validationState?: string;
  createdAt: string;
  activatedAt?: string;
  plan?: {
    identity?: {
      title?: string;
      brand?: string;
      sku?: string;
      requestedVariant?: Record<string, string>;
    };
    expectedCurrency?: string;
    preparationSteps?: Array<{ purpose: string; instruction: string }>;
  };
}

export interface ExecutionSummary {
  id: string;
  monitorId?: string;
  revisionId?: string;
  kind: "compile" | "check" | "repair" | string;
  state: ExecutionState;
  requestedGeneration?: number;
  attempt?: number;
  provider?: "local" | "browserbase" | string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  durationMs?: number;
  failureClassification?: string;
}

export interface Monitor {
  id: string;
  url: string;
  intent: string;
  name?: string;
  status: MonitorStatus;
  condition?: PriceCondition;
  intervalMinutes?: number;
  nextRunAt?: string;
  currentRevisionId?: string;
  currentGeneration?: number;
  latestObservation?: Observation;
  observations?: Observation[];
  revisions?: MonitorRevision[];
  executions?: ExecutionSummary[];
  createdAt: string;
  updatedAt?: string;
}

export interface Artifact {
  id: string;
  kind: "screenshot" | "snapshot" | "trace" | string;
  url: string;
  label?: string;
  createdAt?: string;
}

export interface TraceStep {
  id?: string;
  label: string;
  detail?: string;
  status?: "pending" | "running" | "succeeded" | "failed";
  timestamp?: string;
  durationMs?: number;
}

export interface ExecutionDiagnostics {
  modelCallCount?: number;
  cacheStatus?: "HIT" | "MISS";
  repairSource?: "scripted" | "stagehand";
  timingsMs?: Record<string, number>;
}

export interface Execution extends ExecutionSummary {
  observation?: Observation;
  artifacts?: Artifact[];
  steps?: TraceStep[];
  error?: { message?: string; detail?: string } | string;
  browserSessionUrl?: string;
  traceId?: string;
  diagnostics?: ExecutionDiagnostics;
}

export interface Review {
  monitor: Monitor;
  revision: MonitorRevision;
  evidence?: Artifact[];
  comparison?: {
    previous?: MonitorRevision;
    changes?: Array<{ field: string; before?: string; after?: string }>;
  };
}

export interface CreateMonitorInput {
  url: string;
  intent: string;
  intervalMinutes: number;
}

export interface CreateMonitorResult {
  monitor: Monitor;
  executionId?: string;
}

export interface SystemEvent {
  id: string;
  type: string;
  occurredAt: string;
  monitorId?: string;
  executionId?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export interface ServiceStatus {
  health: "healthy" | "unhealthy" | "unknown";
  ready: "ready" | "not_ready" | "unknown";
  checkedAt: string;
}

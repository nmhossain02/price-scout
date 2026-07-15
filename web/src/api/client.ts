import type {
  CreateMonitorInput,
  CreateMonitorResult,
  Execution,
  ExecutionDiagnostics,
  Monitor,
  MonitorRevision,
  Review,
  ServiceStatus,
} from "../types";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
    const nestedError = typeof record?.error === "object" && record.error !== null
      ? record.error as Record<string, unknown>
      : undefined;
    throw new ApiError(
      String(record?.message ?? nestedError?.message ?? record?.error ?? body ?? `Request failed (${response.status})`),
      response.status,
      record?.details ?? nestedError?.details,
    );
  }

  if (typeof body === "object" && body !== null && "data" in body) {
    return (body as { data: T }).data;
  }
  return body as T;
}

function normalizeCreateResult(raw: CreateMonitorResult | (Monitor & { executionId?: string })): CreateMonitorResult {
  if ("monitor" in raw) return raw;
  return { monitor: raw, executionId: raw.executionId };
}

function normalizeMonitor(
  raw: Monitor | { monitor: Monitor; revisions?: MonitorRevision[]; executions?: Monitor["executions"]; observations?: Monitor["observations"] },
): Monitor {
  const monitor = "monitor" in raw ? raw.monitor : raw;
  const revisions = "monitor" in raw ? raw.revisions ?? monitor.revisions : monitor.revisions;
  const observations = "monitor" in raw ? raw.observations ?? monitor.observations : monitor.observations;
  const executions = ("monitor" in raw ? raw.executions ?? monitor.executions : monitor.executions)?.map((execution) => ({
    ...execution,
    durationMs: execution.durationMs ?? durationBetween(execution.startedAt, execution.completedAt),
  }));
  const latestObservation = [...(observations ?? [])].sort(
    (a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime(),
  )[0] ?? monitor.latestObservation;
  const currentGeneration = revisions?.find((revision) => revision.id === monitor.currentRevisionId)?.generation
    ?? revisions?.filter((revision) => revision.activatedAt).sort((a, b) => b.generation - a.generation)[0]?.generation;
  return { ...monitor, revisions, executions, observations, latestObservation, currentGeneration };
}

function durationBetween(startedAt?: string, completedAt?: string): number | undefined {
  if (!startedAt || !completedAt) return undefined;
  const duration = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function normalizeExecution(raw: Execution): Execution {
  const result = asRecord((raw as Execution & { result?: unknown }).result);
  const stored = asRecord(result?.diagnostics);
  const source = stored ?? raw.diagnostics;
  const timingsMs = numericRecord(source?.timingsMs);
  const modelCallCount = typeof source?.modelCallCount === "number"
    && Number.isInteger(source.modelCallCount)
    && source.modelCallCount >= 0
    ? source.modelCallCount
    : undefined;
  const cacheStatus: ExecutionDiagnostics["cacheStatus"] = source?.cacheStatus === "HIT" || source?.cacheStatus === "MISS"
    ? source.cacheStatus as "HIT" | "MISS"
    : undefined;
  const repairSource: ExecutionDiagnostics["repairSource"] = source?.repairSource === "scripted" || source?.repairSource === "stagehand"
    ? source.repairSource as "scripted" | "stagehand"
    : undefined;
  const diagnostics: ExecutionDiagnostics | undefined = modelCallCount !== undefined || cacheStatus || repairSource || timingsMs
    ? { modelCallCount, cacheStatus, repairSource, timingsMs }
    : undefined;
  return {
    ...raw,
    durationMs: raw.durationMs ?? durationBetween(raw.startedAt, raw.completedAt),
    diagnostics,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function numericRecord(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const entries = Object.entries(record).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0,
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export const api = {
  async listMonitors(): Promise<Monitor[]> {
    const value = await request<Monitor[] | { monitors: Monitor[] } | { items: Monitor[] }>("/api/v1/monitors");
    if (Array.isArray(value)) return value;
    return "items" in value ? value.items : value.monitors;
  },

  async getMonitor(id: string): Promise<Monitor> {
    const value = await request<Monitor | { monitor: Monitor; revisions?: MonitorRevision[]; executions?: Monitor["executions"]; observations?: Monitor["observations"] }>(`/api/v1/monitors/${encodeURIComponent(id)}`);
    return normalizeMonitor(value);
  },

  async createMonitor(input: CreateMonitorInput): Promise<CreateMonitorResult> {
    const result = await request<CreateMonitorResult | (Monitor & { executionId?: string }) | { monitor: Monitor; execution?: { id: string } }>("/api/v1/monitors", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if ("execution" in result) return { monitor: result.monitor, executionId: result.execution?.id };
    return normalizeCreateResult(result);
  },

  updateMonitor(id: string, input: Record<string, unknown>): Promise<Monitor> {
    return request<Monitor | { monitor: Monitor }>(`/api/v1/monitors/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }).then(normalizeMonitor);
  },

  confirmMonitor(id: string, revision: MonitorRevision, condition?: Monitor["condition"]): Promise<Monitor> {
    return request<Monitor | { monitor: Monitor }>(`/api/v1/monitors/${encodeURIComponent(id)}/confirm`, {
      method: "POST",
      body: JSON.stringify({ revisionId: revision.id, condition }),
    }).then(normalizeMonitor);
  },

  async runCheck(id: string): Promise<{ executionId: string }> {
    const value = await request<{ executionId: string } | { execution: { id: string }; created?: boolean }>(`/api/v1/monitors/${encodeURIComponent(id)}/checks`, {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
    return "execution" in value ? { executionId: value.execution.id } : value;
  },

  getExecution(id: string): Promise<Execution> {
    return request<Execution>(`/api/v1/executions/${encodeURIComponent(id)}`).then(normalizeExecution);
  },

  async getReview(monitorId: string, revisionId: string): Promise<Review> {
    const monitor = await this.getMonitor(monitorId);
    const revision = monitor.revisions?.find((item) => item.id === revisionId);
    if (!revision) throw new ApiError("Revision was not found on this monitor", 404);
    const previous = monitor.revisions
      ?.filter((item) => item.generation < revision.generation)
      .sort((a, b) => b.generation - a.generation)[0];
    const candidateExecution = monitor.executions
      ?.filter((item) => item.kind === revision.source && item.state === "succeeded")
      .sort((a, b) => new Date(b.completedAt ?? b.createdAt).getTime() - new Date(a.completedAt ?? a.createdAt).getTime())[0];
    const execution = candidateExecution ? await this.getExecution(candidateExecution.id).catch(() => undefined) : undefined;
    const changes: Array<{ field: string; before?: string; after?: string }> = [];
    const beforeIdentity = previous?.plan?.identity;
    const afterIdentity = revision.plan?.identity;
    if (beforeIdentity?.title !== afterIdentity?.title) changes.push({ field: "product title", before: beforeIdentity?.title, after: afterIdentity?.title });
    if (beforeIdentity?.sku !== afterIdentity?.sku) changes.push({ field: "sku", before: beforeIdentity?.sku, after: afterIdentity?.sku });
    if (previous?.plan?.expectedCurrency !== revision.plan?.expectedCurrency) changes.push({ field: "currency", before: previous?.plan?.expectedCurrency, after: revision.plan?.expectedCurrency });
    if (previous?.plan?.preparationSteps?.length !== revision.plan?.preparationSteps?.length) changes.push({ field: "preparation actions", before: String(previous?.plan?.preparationSteps?.length ?? 0), after: String(revision.plan?.preparationSteps?.length ?? 0) });
    return { monitor, revision, evidence: execution?.artifacts, comparison: { previous, changes } };
  },

  reviewRevision(monitorId: string, revisionId: string, decision: "accept" | "reject"): Promise<Monitor> {
    return request<Monitor | { monitor: Monitor }>(
      `/api/v1/monitors/${encodeURIComponent(monitorId)}/reviews/${encodeURIComponent(revisionId)}/${decision}`,
      { method: "POST" },
    ).then(normalizeMonitor);
  },

  async getServiceStatus(): Promise<ServiceStatus> {
    const check = async (path: string) => {
      try {
        const response = await fetch(`${baseUrl}${path}`);
        return response.ok;
      } catch {
        return false;
      }
    };
    const [healthy, ready] = await Promise.all([check("/healthz"), check("/readyz")]);
    return {
      health: healthy ? "healthy" : "unhealthy",
      ready: ready ? "ready" : "not_ready",
      checkedAt: new Date().toISOString(),
    };
  },

  async getMetrics(): Promise<string> {
    const response = await fetch(`${baseUrl}/metrics`);
    if (!response.ok) throw new ApiError("Metrics endpoint is unavailable", response.status);
    return response.text();
  },
};

export const eventStreamUrl = `${baseUrl}/api/v1/events`;

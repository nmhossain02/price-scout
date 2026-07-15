import { labelize } from "../lib/format";

const tones: Record<string, string> = {
  active: "success",
  healthy: "success",
  ready: "success",
  succeeded: "success",
  verified: "success",
  live: "success",
  awaiting_confirmation: "warning",
  needs_review: "warning",
  compiling: "info",
  queued: "info",
  running: "info",
  connecting: "info",
  paused: "neutral",
  cancelled: "neutral",
  offline: "danger",
  unhealthy: "danger",
  not_ready: "danger",
  blocked: "danger",
  failed: "danger",
};

export function StatusBadge({ status, compact = false }: { status?: string; compact?: boolean }) {
  const tone = tones[status ?? ""] ?? "neutral";
  return (
    <span className={`status-badge status-${tone}${compact ? " status-compact" : ""}`}>
      <span className="status-dot" />
      {labelize(status)}
    </span>
  );
}

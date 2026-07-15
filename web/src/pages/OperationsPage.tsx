import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMetrics, useServiceStatus } from "../api/queries";
import { BoxIcon, ExternalIcon, PulseIcon, RadarIcon, ShieldIcon } from "../components/Icons";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { useLiveEvents } from "../live-events";
import { formatDate, labelize } from "../lib/format";

interface MetricSample { name: string; value: number; labels?: string }

function parseMetrics(raw?: string): MetricSample[] {
  if (!raw) return [];
  return raw.split("\n").filter((line) => line && !line.startsWith("#")).flatMap((line) => {
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]+\})?\s+(-?[0-9.eE+]+)$/);
    if (!match) return [];
    return [{ name: match[1], labels: match[2], value: Number(match[3]) }];
  });
}

const featuredMetricNames = [
  "scout_execution_results_total",
  "scout_outbox_published_total",
  "scout_alert_deliveries_total",
  "scout_sse_connections",
  "scout_http_requests_total",
];

export function OperationsPage() {
  const status = useServiceStatus();
  const metrics = useMetrics();
  const { events, connection } = useLiveEvents();
  const [showRaw, setShowRaw] = useState(false);
  const parsed = useMemo(() => parseMetrics(metrics.data), [metrics.data]);
  const featured = featuredMetricNames.map((name) => ({ name, samples: parsed.filter((metric) => metric.name === name) })).filter((group) => group.samples.length);

  return (
    <div className="page operations-page">
      <PageHeader
        eyebrow="System operations"
        title="Control plane health"
        description="API health, API-local metrics, and live execution events from this installation."
        actions={<a href="/metrics" target="_blank" rel="noreferrer" className="button button-secondary">API /metrics<ExternalIcon /></a>}
      />

      <section className="service-grid">
        <article className="service-card"><span className="service-icon"><PulseIcon /></span><div><small>API liveness</small><strong>Control plane</strong></div><StatusBadge status={status.data?.health ?? (status.isLoading ? "connecting" : "unknown")} compact /></article>
        <article className="service-card"><span className="service-icon"><ShieldIcon /></span><div><small>Readiness</small><strong>Dependencies</strong></div><StatusBadge status={status.data?.ready ?? (status.isLoading ? "connecting" : "unknown")} compact /></article>
        <article className="service-card"><span className="service-icon"><RadarIcon /></span><div><small>SSE connection</small><strong>Event stream</strong></div><StatusBadge status={connection} compact /></article>
        <article className="service-card"><span className="service-icon"><BoxIcon /></span><div><small>Last probe</small><strong>{status.data ? new Date(status.data.checkedAt).toLocaleTimeString() : "—"}</strong></div><span className="muted">15s interval</span></article>
      </section>

      <section>
        <div className="section-heading"><div><h2>API runtime signals</h2><p>Prometheus samples from this API process only.</p></div><button className="text-button" onClick={() => setShowRaw((value) => !value)}>{showRaw ? "Show cards" : "Inspect raw metrics"}</button></div>
        {showRaw ? <pre className="metrics-raw">{metrics.data ?? (metrics.isLoading ? "Loading metrics…" : "Metrics endpoint unavailable")}</pre> : featured.length ? <div className="metric-cards">{featured.map((group) => <article key={group.name}><span>{labelize(group.name.replace(/^scout_/, ""))}</span><strong>{group.samples.reduce((sum, sample) => sum + sample.value, 0).toLocaleString()}</strong><small>{group.samples.length > 1 ? `${group.samples.length} labeled series` : group.samples[0]?.labels ?? "Current value"}</small></article>)}</div> : <div className="panel panel-empty metrics-empty"><PulseIcon /><p>{metrics.isLoading ? "Loading runtime metrics…" : "No Price Scout metrics have been emitted yet."}</p></div>}
      </section>

      <section className="ops-note"><PulseIcon /><div><strong>Cross-service metrics</strong><p>Run <code>make ops-up</code>, then use <a href="http://127.0.0.1:3001" target="_blank" rel="noreferrer">Grafana on port 3001</a> for Prometheus aggregation across the API, scheduler, and NATS exporter. Worker-specific diagnostics remain on execution pages and in worker logs.</p></div></section>

      <section>
        <div className="section-heading"><div><h2>Live event log</h2><p>Most recent events appear first and remain in this browser session.</p></div><StatusBadge status={connection} compact /></div>
        <div className="panel event-log">
          {events.length ? events.map((event) => <div className="event-row" key={event.id}><span className="event-pulse" /><div><strong>{labelize(event.type)}</strong><p>{event.message ?? "System state changed"}</p></div><div className="event-links">{event.monitorId && <Link to={`/monitors/${event.monitorId}`}>Monitor</Link>}{event.executionId && <Link to={`/executions/${event.executionId}`}>Execution</Link>}</div><time>{formatDate(event.occurredAt)}</time></div>) : <div className="event-empty"><RadarIcon /><div><strong>Waiting for system activity</strong><p>Compile or check a monitor to see live events here.</p></div></div>}
        </div>
      </section>

      <section className="ops-note"><ShieldIcon /><div><strong>Local operator console</strong><p>This UI is unauthenticated and should remain bound to <code>127.0.0.1</code>, or sit behind an authenticated reverse proxy.</p></div></section>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useConfirmMonitor, useMonitor, useRunCheck, useUpdateMonitor } from "../api/queries";
import { ErrorState, InlineError, PageSpinner } from "../components/AsyncState";
import { CameraIcon, CheckIcon, ClockIcon, ExternalIcon, PauseIcon, PlayIcon, ShieldIcon } from "../components/Icons";
import { PageHeader } from "../components/PageHeader";
import { PriceChart } from "../components/PriceChart";
import { StatusBadge } from "../components/StatusBadge";
import { formatDate, formatDuration, formatMoney, formatRelative, hostname, labelize } from "../lib/format";
import type { Monitor, MonitorRevision, PriceCondition } from "../types";

function ConfirmationPanel({ monitor, revision }: { monitor: Monitor; revision: MonitorRevision }) {
  const confirm = useConfirmMonitor(monitor.id);
  const [price, setPrice] = useState(monitor.condition?.priceBelowMinor ? String(monitor.condition.priceBelowMinor / 100) : "");
  const [currency, setCurrency] = useState(monitor.condition?.currency ?? revision.plan?.expectedCurrency ?? "USD");
  const [inStock, setInStock] = useState(monitor.condition?.requireInStock ?? true);

  const submit = () => {
    const condition: PriceCondition = {
      priceBelowMinor: price ? Math.round(Number(price) * 100) : undefined,
      currency: currency.toUpperCase(),
      requireInStock: inStock,
      requestedVariant: monitor.condition?.requestedVariant ?? revision.plan?.identity?.requestedVariant ?? {},
    };
    confirm.mutate({ revision, condition });
  };

  return (
    <section className="attention-panel">
      <div className="attention-heading">
        <div className="attention-icon"><ShieldIcon /></div>
        <div><span className="eyebrow">Confirmation required</span><h2>Did Price Scout understand this product?</h2><p>Review the extracted identity and rule. Monitoring starts only after you approve it.</p></div>
      </div>
      <div className="confirmation-grid">
        <div className="confirmation-product">
          <span>Detected product</span>
          <strong>{revision.plan?.identity?.title ?? monitor.latestObservation?.title ?? "Product identity pending"}</strong>
          <dl>
            {revision.plan?.identity?.brand && <><dt>Brand</dt><dd>{revision.plan.identity.brand}</dd></>}
            {revision.plan?.identity?.sku && <><dt>SKU</dt><dd>{revision.plan.identity.sku}</dd></>}
            {Object.entries(revision.plan?.identity?.requestedVariant ?? {}).map(([key, value]) => <span className="definition-row" key={key}><dt>{labelize(key)}</dt><dd>{value}</dd></span>)}
          </dl>
        </div>
        <div className="confirmation-rule">
          <label className="field"><span>Alert below</span><div className="money-field"><select value={currency} onChange={(event) => setCurrency(event.target.value)} aria-label="Currency"><option>USD</option><option>CAD</option><option>EUR</option><option>GBP</option><option>AUD</option></select><input type="number" min="0.01" step="0.01" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="130.00" aria-label="Target price" /></div></label>
          <label className="toggle-line"><input type="checkbox" checked={inStock} onChange={(event) => setInStock(event.target.checked)} /><span><strong>Require in-stock status</strong><small>Do not alert for unavailable inventory.</small></span></label>
        </div>
      </div>
      <InlineError error={confirm.error} />
      <div className="attention-actions">
        {monitor.latestObservation?.executionId && <Link className="button button-ghost" to={`/executions/${monitor.latestObservation.executionId}`}><CameraIcon />Inspect evidence</Link>}
        <button className="button button-primary" onClick={submit} disabled={confirm.isPending || !price || Number(price) <= 0}>{confirm.isPending ? "Activating…" : <><CheckIcon />Confirm and activate</>}</button>
      </div>
    </section>
  );
}

export function MonitorDetailPage() {
  const { monitorId = "" } = useParams();
  const navigate = useNavigate();
  const monitor = useMonitor(monitorId);
  const update = useUpdateMonitor(monitorId);
  const runCheck = useRunCheck(monitorId);
  const [actionMessage, setActionMessage] = useState<string>();

  useEffect(() => {
    if (!actionMessage) return;
    const timeout = window.setTimeout(() => setActionMessage(undefined), 4_000);
    return () => window.clearTimeout(timeout);
  }, [actionMessage]);

  const latestCandidate = useMemo(() => {
    const revisions = monitor.data?.revisions ?? [];
    return [...revisions].sort((a, b) => b.generation - a.generation).find((item) => !item.activatedAt || item.validationState === "needs_review");
  }, [monitor.data?.revisions]);

  if (monitor.isLoading) return <PageSpinner label="Loading product monitor" />;
  if (monitor.isError || !monitor.data) return <ErrorState error={monitor.error ?? new Error("Monitor not found")} />;

  const item = monitor.data;
  const observations = item.observations ?? (item.latestObservation ? [item.latestObservation] : []);
  const latest = item.latestObservation ?? observations.at(0);
  const currency = latest?.currency ?? item.condition?.currency ?? "USD";
  const target = item.condition?.priceBelowMinor;
  const targetMet = latest?.priceMinor !== undefined && target !== undefined && latest.priceMinor < target && (!item.condition?.requireInStock || latest.inStock);

  const togglePause = async () => {
    const paused = item.status === "paused";
    await update.mutateAsync({ action: paused ? "resume" : "pause" });
    setActionMessage(paused ? "Monitor resumed." : "Monitor paused.");
  };

  const checkNow = async () => {
    const result = await runCheck.mutateAsync();
    if (result.executionId) navigate(`/executions/${result.executionId}`);
  };

  return (
    <div className="page">
      <div className="crumbs"><Link to="/">Monitors</Link><span>/</span><span>{item.name ?? hostname(item.url)}</span></div>
      <PageHeader
        eyebrow={hostname(item.url)}
        title={<>{item.name ?? latest?.title ?? "Product monitor"} <StatusBadge status={item.status} /></>}
        description={<a href={item.url} target="_blank" rel="noreferrer" className="source-link">{item.url}<ExternalIcon /></a>}
        actions={<>
          <button className="button button-secondary" onClick={togglePause} disabled={update.isPending || ["compiling", "awaiting_confirmation"].includes(item.status)}>{item.status === "paused" ? <><PlayIcon />Resume</> : <><PauseIcon />Pause</>}</button>
          <button className="button button-primary" onClick={checkNow} disabled={runCheck.isPending || item.status !== "active"}>{runCheck.isPending ? "Queuing…" : <><PlayIcon />Check now</>}</button>
        </>}
      />

      {actionMessage && <div className="toast-message"><CheckIcon />{actionMessage}</div>}
      <InlineError error={update.error ?? runCheck.error} />
      {(item.status === "awaiting_confirmation" || item.status === "needs_review") && latestCandidate && <ConfirmationPanel monitor={item} revision={latestCandidate} />}
      {item.status === "compiling" && (
        <section className="compiling-banner"><span className="spinner" /><div><strong>Browser compiling this page</strong><p>We’re discovering the product, selecting your requested variant, and collecting evidence for review.</p></div></section>
      )}

      <section className="monitor-overview-grid">
        <article className="panel price-panel">
          <div className="panel-heading"><div><span className="eyebrow">Verified price</span><h2>{formatMoney(latest?.priceMinor, currency)}</h2></div>{latest && <StatusBadge status={latest.verificationState ?? "verified"} compact />}</div>
          <div className="price-meta">
            <span><strong>{latest?.inStock === undefined ? "Unknown" : latest.inStock ? "In stock" : "Out of stock"}</strong>Availability</span>
            <span><strong>{target === undefined ? "No target" : formatMoney(target, currency)}</strong>Alert threshold</span>
            <span><strong>{item.currentGeneration ? `Generation ${item.currentGeneration}` : "Not compiled"}</strong>Monitor plan</span>
          </div>
          {targetMet && <div className="target-hit"><CheckIcon /><span><strong>Target condition is currently met</strong>The alert evaluator will confirm this in a fresh browser before delivery.</span></div>}
          <PriceChart observations={observations} />
        </article>

        <aside className="panel rule-panel">
          <div className="panel-heading"><div><span className="eyebrow">Monitoring rule</span><h3>{item.intent}</h3></div></div>
          <dl className="detail-list">
            <div><dt>Schedule</dt><dd>Every {item.intervalMinutes ?? 360} minutes</dd></div>
            <div><dt>Next check</dt><dd>{item.status === "active" ? formatRelative(item.nextRunAt) : "Not scheduled"}</dd></div>
            <div><dt>Stock required</dt><dd>{item.condition?.requireInStock ? "Yes" : "No"}</dd></div>
            <div><dt>Browser policy</dt><dd>Read-only action allowlist</dd></div>
          </dl>
          {Object.keys(item.condition?.requestedVariant ?? {}).length > 0 && <div className="variant-block"><span>Requested variant</span><div>{Object.entries(item.condition?.requestedVariant ?? {}).map(([key, value]) => <span className="variant-pill" key={key}>{labelize(key)}: <strong>{value}</strong></span>)}</div></div>}
          <div className="safe-callout"><ShieldIcon /><p><strong>Policy + validation</strong>Preparation actions use an allowlist; identity, variant, price semantics, and currency are validated before any alert. This is not a general browser sandbox.</p></div>
        </aside>
      </section>

      <section className="split-sections">
        <div>
          <div className="section-heading"><div><h2>Recent checks</h2><p>Browser work and its outcome.</p></div></div>
          <div className="panel compact-table-wrap">
            {(item.executions ?? []).length ? <table className="data-table"><thead><tr><th>Type</th><th>State</th><th>Duration</th><th>Started</th><th /></tr></thead><tbody>{item.executions?.map((execution) => <tr key={execution.id}><td><strong>{labelize(execution.kind)}</strong><small>{execution.provider ?? "local"} browser</small></td><td><StatusBadge status={execution.state} compact /></td><td>{formatDuration(execution.durationMs)}</td><td>{formatDate(execution.startedAt ?? execution.createdAt)}</td><td><Link to={`/executions/${execution.id}`} className="table-link">Inspect</Link></td></tr>)}</tbody></table> : <p className="panel-empty">No checks have run yet.</p>}
          </div>
        </div>
        <div>
          <div className="section-heading"><div><h2>Plan revisions</h2><p>Compiled and repaired monitor generations.</p></div></div>
          <div className="panel revision-list">
            {(item.revisions ?? []).length ? [...(item.revisions ?? [])].sort((a, b) => b.generation - a.generation).map((revision) => (
              <div className="revision-row" key={revision.id}>
                <span className="generation-mark">G{revision.generation}</span>
                <div><strong>{revision.source === "repair" ? "Self-healed plan" : "Initial compilation"}</strong><small>{formatDate(revision.activatedAt ?? revision.createdAt)}</small></div>
                <StatusBadge
                  status={revision.id === item.currentRevisionId
                    ? "active"
                    : revision.activatedAt
                      ? "superseded"
                      : revision.validationState}
                  compact
                />
                {!revision.activatedAt && <Link to={`/monitors/${item.id}/reviews/${revision.id}`} className="table-link">Review</Link>}
              </div>
            )) : <p className="panel-empty">No compiled plan yet.</p>}
          </div>
        </div>
      </section>
      <footer className="monitor-footer"><ClockIcon />Created {formatDate(item.createdAt)} · Last updated {formatDate(item.updatedAt)}</footer>
    </div>
  );
}

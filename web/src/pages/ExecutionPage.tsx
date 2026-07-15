import { Link, useParams } from "react-router-dom";
import { useExecution } from "../api/queries";
import { ErrorState, PageSpinner } from "../components/AsyncState";
import { CameraIcon, CheckIcon, ExternalIcon, PulseIcon, XIcon } from "../components/Icons";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { formatDate, formatDuration, formatMoney, labelize } from "../lib/format";

export function ExecutionPage() {
  const { executionId = "" } = useParams();
  const execution = useExecution(executionId);

  if (execution.isLoading) return <PageSpinner label="Loading execution trace" />;
  if (execution.isError || !execution.data) return <ErrorState error={execution.error ?? new Error("Execution not found")} />;

  const item = execution.data;
  const errorText = typeof item.error === "string" ? item.error : item.error?.message;
  const screenshots = item.artifacts?.filter((artifact) => artifact.kind === "screenshot") ?? [];
  const otherArtifacts = item.artifacts?.filter((artifact) => artifact.kind !== "screenshot") ?? [];
  const diagnostics = item.diagnostics;
  const timings = Object.entries(diagnostics?.timingsMs ?? {});
  const hasPlanSignals = diagnostics?.cacheStatus !== undefined
    || diagnostics?.modelCallCount !== undefined
    || diagnostics?.repairSource !== undefined;

  return (
    <div className="page">
      <div className="crumbs"><Link to={item.monitorId ? `/monitors/${item.monitorId}` : "/"}>Monitor</Link><span>/</span><span>Execution {item.id.slice(0, 8)}</span></div>
      <PageHeader
        eyebrow={`${labelize(item.kind)} execution`}
        title={<>Execution trace <StatusBadge status={item.state} /></>}
        description={`Attempt ${item.attempt ?? 1} · ${item.provider ?? "local"} browser · ${formatDate(item.startedAt ?? item.createdAt)}`}
        actions={item.browserSessionUrl && <a className="button button-secondary" href={item.browserSessionUrl} target="_blank" rel="noreferrer">Browser session<ExternalIcon /></a>}
      />

      <section className="execution-summary">
        <article><span>Duration</span><strong>{formatDuration(item.durationMs)}</strong></article>
        <article><span>Generation</span><strong>{item.requestedGeneration ? `G${item.requestedGeneration}` : "—"}</strong></article>
        <article><span>Trace ID</span><strong className="mono">{item.traceId?.slice(0, 12) ?? "—"}</strong></article>
        <article><span>Result</span><strong>{labelize(item.state)}</strong></article>
      </section>

      {errorText && <section className="execution-error"><XIcon /><div><strong>{labelize(item.failureClassification ?? "Execution failed")}</strong><p>{errorText}</p>{typeof item.error === "object" && item.error.detail && <pre>{item.error.detail}</pre>}</div></section>}

      {item.observation && (
        <section className="panel observation-result">
          <div><span className="eyebrow">Observation</span><h2>{formatMoney(item.observation.priceMinor, item.observation.currency)}</h2><p>{item.observation.title}</p></div>
          <div className="observation-checks"><span><CheckIcon />Identity matched</span><span><CheckIcon />{item.observation.inStock ? "In stock" : "Out of stock"}</span><StatusBadge status={item.observation.verificationState ?? "verified"} /></div>
        </section>
      )}

      <section className="execution-grid">
        <div>
          <div className="section-heading"><div><h2>Browser timeline</h2><p>Each meaningful stage of the execution.</p></div></div>
          <div className="panel timeline">
            {(item.steps ?? []).length ? item.steps?.map((step, index) => (
              <div className="timeline-step" key={step.id ?? `${step.label}-${index}`}>
                <span className={`timeline-node timeline-${step.status ?? "succeeded"}`}>{step.status === "failed" ? <XIcon /> : <CheckIcon />}</span>
                <div><strong>{step.label}</strong>{step.detail && <p>{step.detail}</p>}<small>{formatDate(step.timestamp)}{step.durationMs !== undefined ? ` · ${formatDuration(step.durationMs)}` : ""}</small></div>
              </div>
            )) : <p className="panel-empty">Detailed steps were not recorded for this execution.</p>}
          </div>
        </div>
        <div>
          <div className="section-heading"><div><h2>Evidence</h2><p>Evidence captured during the browser run.</p></div></div>
          <div className="evidence-grid">
            {screenshots.map((artifact) => <a className="evidence-card" href={artifact.url} target="_blank" rel="noreferrer" key={artifact.id}><img src={artifact.url} alt={artifact.label ?? "Browser screenshot evidence"} /><span><CameraIcon />{artifact.label ?? "Browser screenshot"}<ExternalIcon /></span></a>)}
            {!screenshots.length && <div className="panel panel-empty evidence-empty"><CameraIcon /><p>No screenshot evidence attached.</p></div>}
          </div>
          {otherArtifacts.length > 0 && <div className="artifact-links">{otherArtifacts.map((artifact) => <a href={artifact.url} target="_blank" rel="noreferrer" key={artifact.id}><PulseIcon />{artifact.label ?? labelize(artifact.kind)}<ExternalIcon /></a>)}</div>}
        </div>
      </section>

      {hasPlanSignals && <section><div className="section-heading"><div><h2>Plan execution</h2><p>Price Scout compiled-plan replay and worker inference signals. This is separate from Stagehand ActCache.</p></div></div><div className="metric-cards">
        {diagnostics?.cacheStatus && <article><span>Price Scout compiled plan</span><strong>{diagnostics.cacheStatus === "HIT" ? "Replayed" : "Not replayed"}</strong><small>{diagnostics.cacheStatus === "HIT" ? "Reused the stored compiled plan" : "Compile or repair execution; no compiled-plan replay"}</small></article>}
        {diagnostics?.modelCallCount !== undefined && <article><span>Inference operations</span><strong>{diagnostics.modelCallCount.toLocaleString()}</strong><small>{diagnostics.modelCallCount === 0 ? "No inference initiated by Price Scout" : "Logical Price Scout operations; not provider HTTP requests"}</small></article>}
        {diagnostics?.repairSource && <article><span>Repair source</span><strong>{labelize(diagnostics.repairSource)}</strong><small>How this repair plan was produced</small></article>}
      </div></section>}

      {timings.length > 0 && <section><div className="section-heading"><div><h2>Execution timings</h2><p>Worker stage durations reported with the execution result.</p></div></div><div className="metric-cards">{timings.map(([key, value]) => <article key={key}><span>{labelize(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2"))}</span><strong>{formatDuration(value)}</strong><small>{value.toLocaleString()} ms</small></article>)}</div></section>}
    </div>
  );
}

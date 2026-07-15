import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useReview, useReviewDecision } from "../api/queries";
import { ErrorState, InlineError, PageSpinner } from "../components/AsyncState";
import { CameraIcon, CheckIcon, ExternalIcon, ShieldIcon, XIcon } from "../components/Icons";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { formatDate, hostname, labelize } from "../lib/format";

export function ReviewPage() {
  const { monitorId = "", revisionId = "" } = useParams();
  const navigate = useNavigate();
  const review = useReview(monitorId, revisionId);
  const decision = useReviewDecision(monitorId, revisionId);
  const [confirmReject, setConfirmReject] = useState(false);

  if (review.isLoading) return <PageSpinner label="Loading repair candidate" />;
  if (review.isError || !review.data) return <ErrorState error={review.error ?? new Error("Review not found")} />;

  const { monitor, revision, comparison, evidence } = review.data;
  const accept = async () => {
    await decision.mutateAsync("accept");
    navigate(`/monitors/${monitorId}`);
  };
  const reject = async () => {
    await decision.mutateAsync("reject");
    navigate(`/monitors/${monitorId}`);
  };

  return (
    <div className="page narrow-page">
      <div className="crumbs"><Link to="/">Monitors</Link><span>/</span><Link to={`/monitors/${monitor.id}`}>{monitor.name ?? hostname(monitor.url)}</Link><span>/</span><span>Review generation {revision.generation}</span></div>
      <PageHeader
        eyebrow={revision.source === "repair" ? "Self-heal review" : "Compilation review"}
        title={<>Review candidate G{revision.generation} <StatusBadge status={revision.validationState ?? "needs_review"} /></>}
        description="This plan is quarantined. Scheduled checks continue only after the new identity and actions are reviewed."
      />

      <section className="review-hero">
        <ShieldIcon />
        <div><strong>No alert can fire from this candidate</strong><p>Price Scout requires a normal, deterministic check after activation before evaluating the price condition.</p></div>
      </section>

      <div className="review-grid">
        <section className="panel">
          <div className="panel-heading"><div><span className="eyebrow">Proposed identity</span><h2>{revision.plan?.identity?.title ?? "Identity not included"}</h2></div></div>
          <dl className="detail-list">
            <div><dt>Generation</dt><dd>G{revision.generation}</dd></div>
            <div><dt>Source</dt><dd>{labelize(revision.source)}</dd></div>
            <div><dt>Brand</dt><dd>{revision.plan?.identity?.brand ?? "—"}</dd></div>
            <div><dt>SKU</dt><dd>{revision.plan?.identity?.sku ?? "—"}</dd></div>
            <div><dt>Currency</dt><dd>{revision.plan?.expectedCurrency ?? "—"}</dd></div>
            <div><dt>Created</dt><dd>{formatDate(revision.createdAt)}</dd></div>
          </dl>
          {Object.keys(revision.plan?.identity?.requestedVariant ?? {}).length > 0 && <div className="variant-block"><span>Requested variant</span><div>{Object.entries(revision.plan?.identity?.requestedVariant ?? {}).map(([key, value]) => <span className="variant-pill" key={key}>{labelize(key)}: <strong>{value}</strong></span>)}</div></div>}
        </section>

        <section className="panel">
          <div className="panel-heading"><div><span className="eyebrow">Deterministic preparation</span><h2>{revision.plan?.preparationSteps?.length ?? 0} browser actions</h2></div></div>
          {(revision.plan?.preparationSteps ?? []).length ? <ol className="action-list">{revision.plan?.preparationSteps?.map((step, index) => <li key={`${step.purpose}-${index}`}><span>{index + 1}</span><div><strong>{labelize(step.purpose)}</strong><p>{step.instruction}</p></div></li>)}</ol> : <p className="panel-empty">No preparation actions are required.</p>}
        </section>
      </div>

      {(evidence ?? []).length > 0 && <section><div className="section-heading"><div><h2>Validation evidence</h2><p>Captured by the browser that produced this candidate.</p></div></div><div className="evidence-grid">{evidence?.map((artifact) => <a className="evidence-card" href={artifact.url} target="_blank" rel="noreferrer" key={artifact.id}>{artifact.kind === "screenshot" ? <img src={artifact.url} alt={artifact.label ?? "Candidate validation screenshot"} /> : <div className="artifact-preview"><CameraIcon /></div>}<span><CameraIcon />{artifact.label ?? labelize(artifact.kind)}<ExternalIcon /></span></a>)}</div></section>}

      {comparison?.changes?.length ? <section><div className="section-heading"><div><h2>What changed</h2><p>Difference from the active generation.</p></div></div><div className="panel change-list">{comparison.changes.map((change) => <div key={change.field}><strong>{labelize(change.field)}</strong><span className="before-value">{change.before ?? "—"}</span><span>→</span><span className="after-value">{change.after ?? "—"}</span></div>)}</div></section> : null}

      <section className="review-decision panel">
        <div><h2>Approve this monitor plan?</h2><p>Accept only if the product identity, requested variant, and currency still match your intent.</p></div>
        <InlineError error={decision.error} />
        <div className="review-buttons">
          {!confirmReject ? <button className="button button-danger-ghost" onClick={() => setConfirmReject(true)}><XIcon />Reject candidate</button> : <div className="reject-confirm"><span>Keep the prior plan and block this candidate?</span><button className="button button-danger" onClick={reject} disabled={decision.isPending}>Yes, reject</button><button className="button button-ghost" onClick={() => setConfirmReject(false)}>Cancel</button></div>}
          <button className="button button-primary" onClick={accept} disabled={decision.isPending}><CheckIcon />{decision.isPending ? "Applying…" : "Accept repaired plan"}</button>
        </div>
      </section>
    </div>
  );
}

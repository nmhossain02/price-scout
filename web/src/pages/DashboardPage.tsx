import { Link } from "react-router-dom";
import { useMonitors } from "../api/queries";
import { ArrowIcon, PlusIcon, ShieldIcon } from "../components/Icons";
import { EmptyState, ErrorState, PageSpinner } from "../components/AsyncState";
import { PageHeader } from "../components/PageHeader";
import { StatusBadge } from "../components/StatusBadge";
import { formatMoney, formatRelative, hostname } from "../lib/format";

export function DashboardPage() {
  const monitors = useMonitors();

  if (monitors.isLoading) return <PageSpinner label="Loading monitors" />;
  if (monitors.isError) return <ErrorState error={monitors.error} />;

  const items = monitors.data ?? [];
  const active = items.filter((monitor) => monitor.status === "active").length;
  const reviews = items.filter((monitor) => monitor.status === "needs_review" || monitor.status === "awaiting_confirmation").length;
  const observations = items.filter((monitor) => monitor.latestObservation).length;

  return (
    <div className="page dashboard-page">
      <PageHeader
        eyebrow="Command center"
        title="Product monitors"
        description="Evidence-backed prices, compiled into repeatable browser checks."
        actions={<Link className="button button-primary" to="/monitors/new"><PlusIcon />New monitor</Link>}
      />

      <section className="stats-grid" aria-label="Monitor overview">
        <article className="stat-card"><span>Active monitors</span><strong>{active}</strong><small>{items.length} total configured</small></article>
        <article className="stat-card"><span>Verified products</span><strong>{observations}</strong><small>With a validated observation</small></article>
        <article className={`stat-card${reviews > 0 ? " stat-attention" : ""}`}><span>Needs attention</span><strong>{reviews}</strong><small>{reviews ? "Review before monitoring continues" : "No interventions pending"}</small></article>
        <article className="stat-card stat-system"><span><ShieldIcon />Browser policy</span><strong>Read-only policy</strong><small>Action allowlist + result validation</small></article>
      </section>

      <div className="section-heading">
        <div><h2>All monitors</h2><p>Latest validated state from each product page.</p></div>
      </div>

      {items.length === 0 ? (
        <EmptyState
          title="No products on the radar yet"
          body="Describe what matters to you. Price Scout will compile the page into a repeatable monitor and show you the evidence before it starts."
          action={<Link to="/monitors/new" className="button button-primary"><PlusIcon />Create your first monitor</Link>}
        />
      ) : (
        <section className="monitor-list">
          {items.map((monitor) => {
            const observation = monitor.latestObservation;
            const target = monitor.condition?.priceBelowMinor;
            const currency = observation?.currency ?? monitor.condition?.currency ?? "USD";
            const priceProgress = target && observation?.priceMinor
              ? Math.min(100, Math.round((target / observation.priceMinor) * 100))
              : undefined;
            return (
              <Link className="monitor-row" to={`/monitors/${monitor.id}`} key={monitor.id}>
                <div className="product-avatar">{(monitor.name ?? hostname(monitor.url)).slice(0, 1).toUpperCase()}</div>
                <div className="monitor-identity">
                  <div className="monitor-title-line"><h3>{monitor.name ?? observation?.title ?? hostname(monitor.url)}</h3><StatusBadge status={monitor.status} compact /></div>
                  <p>{monitor.intent}</p>
                  <span className="domain-label">{hostname(monitor.url)}</span>
                </div>
                <div className="monitor-price">
                  <span>Latest price</span>
                  <strong>{formatMoney(observation?.priceMinor, currency)}</strong>
                  {target !== undefined && <small>Target {formatMoney(target, currency)}</small>}
                  {priceProgress !== undefined && <span className="target-meter"><i style={{ width: `${priceProgress}%` }} /></span>}
                </div>
                <div className="monitor-next"><span>Next check</span><strong>{monitor.status === "active" ? formatRelative(monitor.nextRunAt) : "On hold"}</strong><small>{observation?.inStock === false ? "Out of stock" : observation ? "In stock" : "Awaiting first check"}</small></div>
                <ArrowIcon className="row-arrow" />
              </Link>
            );
          })}
        </section>
      )}
    </div>
  );
}

import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useCreateMonitor } from "../api/queries";
import { InlineError } from "../components/AsyncState";
import { ArrowIcon, CheckIcon, RadarIcon, ShieldIcon } from "../components/Icons";
import { PageHeader } from "../components/PageHeader";

const examples = [
  "Alert me when the black 2 TB version is in stock and under $130",
  "Tell me when this drops below $500",
  "Watch the 32 GB model and alert me at $899 or less",
];

export function NewMonitorPage() {
  const navigate = useNavigate();
  const create = useCreateMonitor();
  const [url, setUrl] = useState("");
  const [intent, setIntent] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(360);
  const [fieldError, setFieldError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFieldError(undefined);
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch {
      setFieldError("Enter a complete public http or https product URL.");
      return;
    }
    if (intent.trim().length < 8) {
      setFieldError("Describe the product, variant, and condition in a little more detail.");
      return;
    }
    const result = await create.mutateAsync({ url: url.trim(), intent: intent.trim(), intervalMinutes });
    navigate(`/monitors/${result.monitor.id}`);
  }

  return (
    <div className="page narrow-page">
      <PageHeader
        eyebrow="Monitor compiler"
        title="Track any public product page"
        description="Price Scout opens the page, understands your condition, and asks you to verify the evidence before scheduled checks begin."
      />

      <div className="create-layout">
        <form className="panel create-form" onSubmit={submit}>
          <div className="form-step"><span>1</span><div><strong>Product page</strong><small>Public pages only; the monitor policy excludes login, cart, and checkout workflows.</small></div></div>
          <label className="field">
            <span>Product URL</span>
            <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://store.example.com/products/headphones" autoFocus required />
          </label>

          <div className="form-step"><span>2</span><div><strong>What should we watch for?</strong><small>Include the variant, stock requirement, and target price.</small></div></div>
          <label className="field">
            <span>Tracking instruction</span>
            <textarea value={intent} onChange={(event) => setIntent(event.target.value)} rows={5} placeholder="Alert me when the black 2 TB version is in stock and the price is below $130." required />
          </label>
          <div className="example-chips" aria-label="Example tracking instructions">
            {examples.map((example) => <button type="button" key={example} onClick={() => setIntent(example)}>{example}</button>)}
          </div>

          <div className="form-step"><span>3</span><div><strong>Check cadence</strong><small>Choose a conservative interval; each monitor's executions are serialized.</small></div></div>
          <label className="field">
            <span>Frequency</span>
            <select value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value))}>
              <option value={15}>Every 15 minutes</option>
              <option value={60}>Every hour</option>
              <option value={360}>Every 6 hours (recommended)</option>
              <option value={720}>Every 12 hours</option>
              <option value={1440}>Daily</option>
            </select>
          </label>

          {fieldError && <div className="inline-alert inline-alert-danger" role="alert">{fieldError}</div>}
          <InlineError error={create.error} />
          <div className="form-actions">
            <Link to="/" className="button button-ghost">Cancel</Link>
            <button className="button button-primary button-large" disabled={create.isPending}>
              {create.isPending ? <><span className="spinner spinner-small" />Opening browser…</> : <>Compile monitor<ArrowIcon /></>}
            </button>
          </div>
        </form>

        <aside className="create-aside">
          <div className="aside-visual"><RadarIcon /><span className="scan-ring scan-ring-one" /><span className="scan-ring scan-ring-two" /></div>
          <h2>Agentic once.<br />Deterministic after.</h2>
          <p>An AI-guided browser discovers the product and variant. Once confirmed, checks replay Price Scout compiled-plan actions without inference.</p>
          <ul className="check-list">
            <li><CheckIcon />Price and variant verification</li>
            <li><CheckIcon />Screenshot evidence for every change</li>
            <li><CheckIcon />Coordinated repair after redesigns</li>
          </ul>
          <div className="safety-note"><ShieldIcon /><span><strong>Read-only action policy</strong>Preparation action types are allowlisted and extracted product facts are validated. This is not a general browser sandbox.</span></div>
        </aside>
      </div>
    </div>
  );
}

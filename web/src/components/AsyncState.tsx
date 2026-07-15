import type { ReactNode } from "react";

export function PageSpinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="page-state" role="status">
      <span className="spinner" />
      <p>{label}</p>
    </div>
  );
}

export function ErrorState({ error, action }: { error: unknown; action?: ReactNode }) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div className="page-state error-state" role="alert">
      <span className="error-mark">!</span>
      <h2>We couldn’t load this view</h2>
      <p>{message}</p>
      {action}
    </div>
  );
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : "The request could not be completed.";
  return <div className="inline-alert inline-alert-danger" role="alert">{message}</div>;
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-orbit"><span /></span>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

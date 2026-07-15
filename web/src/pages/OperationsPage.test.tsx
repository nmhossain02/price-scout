import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { renderPage } from "../test/render";
import { OperationsPage } from "./OperationsPage";

describe("OperationsPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("features API-local metrics and points to cross-service aggregation", async () => {
    vi.spyOn(api, "getServiceStatus").mockResolvedValue({
      health: "healthy",
      ready: "ready",
      checkedAt: "2026-01-01T00:00:00Z",
    });
    vi.spyOn(api, "getMetrics").mockResolvedValue([
      'scout_execution_results_total{kind="check",status="succeeded"} 4',
      'scout_execution_results_total{kind="check",status="failed"} 1',
      "scout_scheduled_checks_total 7",
      'scout_outbox_published_total{subject="scout.execution.requested"} 9',
      'scout_alert_deliveries_total{channel="webhook",outcome="delivered"} 2',
      "scout_sse_connections 3",
      'scout_http_requests_total{method="GET",route="/readyz",status="200"} 11',
      "scout_http_request_duration_seconds_sum 99",
    ].join("\n"));

    renderPage(<OperationsPage />);

    const executionCard = (await screen.findByText("Execution Results Total")).closest("article");
    expect(executionCard).not.toBeNull();
    expect(within(executionCard as HTMLElement).getByText("5")).toBeInTheDocument();
    expect(within(executionCard as HTMLElement).getByText("2 labeled series")).toBeInTheDocument();
    expect(screen.queryByText("Scheduled Checks Total")).not.toBeInTheDocument();
    expect(screen.getByText("Outbox Published Total")).toBeInTheDocument();
    expect(screen.getByText("Alert Deliveries Total")).toBeInTheDocument();
    expect(screen.getByText("Sse Connections")).toBeInTheDocument();
    expect(screen.getByText("Http Requests Total")).toBeInTheDocument();
    expect(screen.queryByText("Http Request Duration Seconds Sum")).not.toBeInTheDocument();
    expect(screen.getByText("API runtime signals")).toBeInTheDocument();
    expect(screen.getByText(/API process only/i)).toBeInTheDocument();
    expect(screen.getByText(/worker-specific diagnostics remain on execution pages/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Grafana on port 3001/i })).toHaveAttribute("href", "http://127.0.0.1:3001");
  });
});

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { renderPage } from "../test/render";
import type { Monitor } from "../types";
import { MonitorDetailPage } from "./MonitorDetailPage";

const candidateMonitor: Monitor = {
  id: "m-1",
  url: "https://shop.test/headphones",
  intent: "Alert when the black model is below $130",
  status: "awaiting_confirmation",
  condition: { priceBelowMinor: 13000, currency: "USD", requireInStock: true, requestedVariant: { color: "black" } },
  intervalMinutes: 360,
  createdAt: "2026-01-01T00:00:00Z",
  revisions: [{
    id: "r-1",
    generation: 1,
    source: "compile",
    validationState: "awaiting_confirmation",
    createdAt: "2026-01-01T00:01:00Z",
    plan: { identity: { title: "Studio Headphones", sku: "ST-1", requestedVariant: { color: "black" } }, expectedCurrency: "USD", preparationSteps: [] },
  }],
  executions: [],
  observations: [{ id: "o-1", executionId: "e-1", title: "Studio Headphones", priceMinor: 14999, currency: "USD", inStock: true, verificationState: "verified", observedAt: "2026-01-01T00:01:00Z" }],
  latestObservation: { id: "o-1", executionId: "e-1", title: "Studio Headphones", priceMinor: 14999, currency: "USD", inStock: true, verificationState: "verified", observedAt: "2026-01-01T00:01:00Z" },
};

describe("MonitorDetailPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("confirms a candidate using the persisted worker condition schema", async () => {
    vi.spyOn(api, "getMonitor").mockResolvedValue(candidateMonitor);
    const confirm = vi.spyOn(api, "confirmMonitor").mockResolvedValue({ ...candidateMonitor, status: "active" });
    const user = userEvent.setup();
    renderPage(<Routes><Route path="/monitors/:monitorId" element={<MonitorDetailPage />} /></Routes>, "/monitors/m-1");

    expect(await screen.findByText("Did Price Scout understand this product?")).toBeInTheDocument();
    expect(screen.getByText("Read-only action allowlist")).toBeInTheDocument();
    expect(screen.getByText("Policy + validation")).toBeInTheDocument();
    expect(screen.getByText(/not a general browser sandbox/i)).toBeInTheDocument();
    expect(screen.queryByText("Guardrails active")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Target price")).toHaveValue(130);
    await user.click(screen.getByRole("button", { name: /confirm and activate/i }));

    await waitFor(() => expect(confirm).toHaveBeenCalledWith("m-1", expect.objectContaining({ id: "r-1" }), {
      priceBelowMinor: 13000,
      currency: "USD",
      requireInStock: true,
      requestedVariant: { color: "black" },
    }));
  });

  it("shows only the current revision as active", async () => {
    vi.spyOn(api, "getMonitor").mockResolvedValue({
      ...candidateMonitor,
      status: "active",
      currentRevisionId: "r-2",
      revisions: [
        {
          ...candidateMonitor.revisions![0],
          activatedAt: "2026-01-01T00:02:00Z",
          validationState: "active",
        },
        {
          ...candidateMonitor.revisions![0],
          id: "r-2",
          generation: 2,
          source: "repair",
          activatedAt: "2026-01-01T00:03:00Z",
          validationState: "active",
        },
      ],
    });

    renderPage(<Routes><Route path="/monitors/:monitorId" element={<MonitorDetailPage />} /></Routes>, "/monitors/m-1");

    const currentRow = (await screen.findByText("G2")).closest(".revision-row");
    const previousRow = screen.getByText("G1").closest(".revision-row");
    expect(currentRow).not.toBeNull();
    expect(previousRow).not.toBeNull();
    expect(within(currentRow as HTMLElement).getByText("Active")).toBeInTheDocument();
    expect(within(previousRow as HTMLElement).getByText("Superseded")).toBeInTheDocument();
  });
});

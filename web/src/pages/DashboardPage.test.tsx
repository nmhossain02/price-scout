import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { DashboardPage } from "./DashboardPage";
import { renderPage } from "../test/render";

describe("DashboardPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders verified monitor state and target", async () => {
    vi.spyOn(api, "listMonitors").mockResolvedValue([{
      id: "m-1",
      name: "Studio Headphones",
      url: "https://audio.example/headphones",
      intent: "Alert below $130 when black is in stock",
      status: "active",
      condition: { priceBelowMinor: 13000, currency: "USD", requireInStock: true, requestedVariant: { color: "black" } },
      intervalMinutes: 360,
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      latestObservation: { id: "o-1", priceMinor: 14999, currency: "USD", inStock: true, observedAt: new Date().toISOString() },
      createdAt: "2026-01-01T00:00:00Z",
    }]);

    renderPage(<DashboardPage />);
    expect(await screen.findByText("Studio Headphones")).toBeInTheDocument();
    expect(screen.getByText("Alert below $130 when black is in stock")).toBeInTheDocument();
    expect(screen.getByText(/149\.99/)).toBeInTheDocument();
    expect(screen.getByText(/Target.*130\.00/)).toBeInTheDocument();
    expect(screen.getByText("Read-only policy")).toBeInTheDocument();
    expect(screen.getByText("Action allowlist + result validation")).toBeInTheDocument();
    expect(screen.queryByText("Purchasing actions disabled")).not.toBeInTheDocument();
  });

  it("guides an empty installation toward monitor creation", async () => {
    vi.spyOn(api, "listMonitors").mockResolvedValue([]);
    renderPage(<DashboardPage />);
    expect(await screen.findByText("No products on the radar yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /create your first monitor/i })).toHaveAttribute("href", "/monitors/new");
  });
});

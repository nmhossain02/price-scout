import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { api } from "../api/client";
import { renderPage } from "../test/render";
import type { Execution } from "../types";
import { ExecutionPage } from "./ExecutionPage";

const execution: Execution = {
  id: "execution-1234",
  monitorId: "monitor-1",
  kind: "repair",
  state: "succeeded",
  attempt: 1,
  provider: "browserbase",
  createdAt: "2026-01-01T00:00:00Z",
  diagnostics: {
    modelCallCount: 2,
    cacheStatus: "MISS",
    repairSource: "stagehand",
    timingsMs: { browserInit: 125, total: 3200 },
  },
};

describe("ExecutionPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders nested plan signals and numeric worker timings", async () => {
    vi.spyOn(api, "getExecution").mockResolvedValue(execution);
    renderPage(<Routes><Route path="/executions/:executionId" element={<ExecutionPage />} /></Routes>, "/executions/execution-1234");

    expect(await screen.findByText("Plan execution")).toBeInTheDocument();
    expect(screen.getByText(/separate from Stagehand ActCache/i)).toBeInTheDocument();

    const replayCard = screen.getByText("Price Scout compiled plan").closest("article");
    const modelCard = screen.getByText("Inference operations").closest("article");
    const repairCard = screen.getByText("Repair source").closest("article");
    expect(replayCard).not.toBeNull();
    expect(modelCard).not.toBeNull();
    expect(repairCard).not.toBeNull();
    expect(within(replayCard as HTMLElement).getByText("Not replayed")).toBeInTheDocument();
    expect(within(modelCard as HTMLElement).getByText("2")).toBeInTheDocument();
    expect(within(modelCard as HTMLElement).getByText(/not provider HTTP requests/i)).toBeInTheDocument();
    expect(within(repairCard as HTMLElement).getByText("Stagehand")).toBeInTheDocument();

    const browserTiming = screen.getByText("Browser Init").closest("article");
    const totalTiming = screen.getByText("Total").closest("article");
    expect(browserTiming).not.toBeNull();
    expect(totalTiming).not.toBeNull();
    expect(within(browserTiming as HTMLElement).getByText("125ms")).toBeInTheDocument();
    expect(within(totalTiming as HTMLElement).getByText("3.2s")).toBeInTheDocument();
  });
});

import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { NewMonitorPage } from "./NewMonitorPage";
import { renderPage } from "../test/render";

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

describe("NewMonitorPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("submits the compiler input and navigates to the monitor", async () => {
    const create = vi.spyOn(api, "createMonitor").mockResolvedValue({
      monitor: { id: "m-7", url: "https://shop.test/product", intent: "Alert below $100", status: "compiling", createdAt: "2026-01-01T00:00:00Z" },
      executionId: "e-1",
    });
    const user = userEvent.setup();
    renderPage(<Routes><Route path="/monitors/new" element={<NewMonitorPage />} /><Route path="/monitors/:id" element={<LocationProbe />} /></Routes>, "/monitors/new");

    await user.type(screen.getByLabelText("Product URL"), "https://shop.test/product");
    await user.type(screen.getByLabelText("Tracking instruction"), "Alert me when the item drops below $100");
    await user.click(screen.getByRole("button", { name: /compile monitor/i }));

    expect(create).toHaveBeenCalledWith({ url: "https://shop.test/product", intent: "Alert me when the item drops below $100", intervalMinutes: 360 });
    expect(await screen.findByTestId("location")).toHaveTextContent("/monitors/m-7");
  });

  it("rejects private-scheme URLs before calling the API", async () => {
    const create = vi.spyOn(api, "createMonitor");
    const user = userEvent.setup();
    renderPage(<NewMonitorPage />, "/monitors/new");
    expect(screen.getByText(/replay Price Scout compiled-plan actions without inference/i)).toBeInTheDocument();
    expect(screen.getByText("Read-only action policy")).toBeInTheDocument();
    expect(screen.getByText(/not a general browser sandbox/i)).toBeInTheDocument();
    expect(screen.queryByText(/purchase-safe by design/i)).not.toBeInTheDocument();
    const urlField = screen.getByLabelText("Product URL");
    await user.type(urlField, "file:///etc/passwd");
    await user.type(screen.getByLabelText("Tracking instruction"), "Alert me when this product is under $100");
    // Browser-native URL input validity can prevent submit, so call the form via an allowed-looking value then replace it.
    urlField.setAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: /compile monitor/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/public http or https/i);
    expect(create).not.toHaveBeenCalled();
  });
});

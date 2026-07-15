import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderPage } from "../test/render";
import { Layout } from "./Layout";

describe("Layout", () => {
  it("exposes mobile navigation state and its controlled region", async () => {
    const user = userEvent.setup();
    renderPage(<Layout />);

    const toggle = screen.getByRole("button", { name: "Toggle navigation" });
    expect(toggle).toHaveAttribute("aria-controls", "primary-sidebar");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("primary-sidebar")).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("primary-sidebar")).toHaveClass("sidebar-open");
  });
});

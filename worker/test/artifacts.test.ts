import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureEvidence } from "../src/artifacts.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("evidence capture", () => {
  it("uses a viewport-bounded screenshot for untrusted pages", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "price-scout-artifacts-"));
    directories.push(directory);
    const screenshot = vi.fn().mockResolvedValue(Buffer.from("png"));
    const page = {
      screenshot,
      snapshot: vi.fn().mockResolvedValue({ formattedTree: "product snapshot" }),
    };

    const artifacts = await captureEvidence(page as never, directory, "exec-1");

    expect(screenshot).toHaveBeenCalledWith({ fullPage: false, type: "png" });
    expect(artifacts).toHaveLength(2);
  });
});

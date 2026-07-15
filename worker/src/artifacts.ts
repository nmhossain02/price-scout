import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@browserbasehq/stagehand";
import type { ArtifactRef } from "./contracts.js";

export async function captureEvidence(
  page: Page,
  artifactRoot: string,
  executionId: string,
): Promise<ArtifactRef[]> {
  const safeId = executionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 100);
  const directory = path.resolve(artifactRoot, safeId);
  const root = path.resolve(artifactRoot);
  if (!directory.startsWith(`${root}${path.sep}`)) throw new Error("Unsafe artifact path");
  await mkdir(directory, { recursive: true });

  // Evidence is intentionally viewport-bounded. Untrusted pages can be
  // arbitrarily tall, making full-page capture an uncontrolled memory/file
  // allocation before artifact metadata reaches the control plane.
  const screenshot = await page.screenshot({ fullPage: false, type: "png" });
  const snapshot = await page.snapshot();
  const snapshotBuffer = Buffer.from(snapshot.formattedTree.slice(0, 2_000_000), "utf8");
  const screenshotPath = path.join(directory, "page.png");
  const snapshotPath = path.join(directory, "snapshot.txt");
  await Promise.all([
    writeFile(screenshotPath, screenshot, { mode: 0o600 }),
    writeFile(snapshotPath, snapshotBuffer, { mode: 0o600 }),
  ]);

  return [
    artifact("screenshot", `${safeId}/page.png`, "image/png", screenshot),
    artifact("snapshot", `${safeId}/snapshot.txt`, "text/plain", snapshotBuffer),
  ];
}

function artifact(
  kind: ArtifactRef["kind"],
  storageKey: string,
  contentType: ArtifactRef["contentType"],
  content: Buffer,
): ArtifactRef {
  return {
    kind,
    storageKey,
    contentType,
    sizeBytes: content.byteLength,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

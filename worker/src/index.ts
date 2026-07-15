import { loadConfig } from "./config.js";
import { WorkerQueue } from "./queue.js";

const worker = new WorkerQueue(loadConfig());
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), level: "info", service: "worker", message: "draining", signal }));
  await worker.stop();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

worker.run().catch((error) => {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "error",
    service: "worker",
    message: "worker stopped unexpectedly",
    error: error instanceof Error ? error.message : String(error),
  }));
  process.exitCode = 1;
});

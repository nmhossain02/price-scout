import { z } from "zod";

const envSchema = z.object({
  NATS_URL: z.string().default("nats://nats:4222"),
  INTERNAL_API_URL: z.string().url().default("http://api:8080"),
  WORKER_TOKEN: z.string().min(1).default("development-worker-token"),
  WORKER_QUEUE: z.string().min(1).default("price-scout-workers"),
  WORKER_MAX_IN_FLIGHT: z.coerce.number().int().min(1).max(1024).default(64),
  INFERENCE_MODE: z.enum(["auto", "scripted", "live"]).default("auto"),
  BROWSER_PROVIDER: z.enum(["LOCAL", "BROWSERBASE"]).default("LOCAL"),
  BROWSERBASE_API_KEY: z.string().optional(),
  BROWSERBASE_PROJECT_ID: z.string().optional(),
  MODEL_NAME: z.string().default("openai/gpt-5-mini"),
  MODEL_API_KEY: z.string().optional(),
  CHROME_EXECUTABLE_PATH: z.string().optional(),
  ARTIFACT_DIR: z.string().default("/data/artifacts"),
  FIXTURE_ORIGIN: z.string().url().default("http://fixture:4173"),
  ALLOWED_PRIVATE_HOSTS: z.string().default("fixture,localhost,127.0.0.1"),
  NAVIGATION_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  CONTROL_PLANE_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
});

export type WorkerConfig = z.infer<typeof envSchema> & {
  allowedPrivateHosts: Set<string>;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = envSchema.parse(env);
  return {
    ...parsed,
    allowedPrivateHosts: new Set(
      parsed.ALLOWED_PRIVATE_HOSTS.split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean),
    ),
  };
}

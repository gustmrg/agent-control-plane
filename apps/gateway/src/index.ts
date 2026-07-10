import "node:process";

import { mkdirSync } from "node:fs";

import { buildApp } from "./app.js";
import { DockerodeRuntime } from "./docker/dockerode-runtime.js";
import { openSandboxStore } from "./persistence/store.js";
import { SandboxService } from "./sandboxes/service.js";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const dataDirectory =
  process.env.AGENT_CONTROL_DATA_DIR ?? "/var/lib/agent-control";
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });

const token = required("AGENT_CONTROL_API_TOKEN");
const store = openSandboxStore(`${dataDirectory}/gateway.db`);
const runtime = new DockerodeRuntime(
  process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
);
const defaultImage =
  process.env.AGENT_CONTROL_SANDBOX_IMAGE ?? "agent-control-sandbox:latest";
const service = new SandboxService({ store, runtime, defaultImage });
const app = buildApp({ store, runtime, token, defaultImage, logger: true });

const reconcile = async () => {
  const orphans = await service.reconcile();
  if (orphans.length > 0) {
    app.log.warn(
      { sandboxIds: orphans.map((item) => item.sandboxId) },
      "orphaned sandboxes found",
    );
  }
};

await reconcile();
const interval = setInterval(
  () => void reconcile().catch((error) => app.log.error(error)),
  15_000,
);
interval.unref();

const shutdown = async () => {
  clearInterval(interval);
  await app.close();
  store.close();
};
process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));

await app.listen({
  host: process.env.HOST ?? "0.0.0.0",
  port: Number(process.env.PORT ?? 7070),
});

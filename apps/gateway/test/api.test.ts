import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { buildApp } from "../src/app.js";
import type {
  ContainerRuntime,
  CreateRuntimeSandbox,
  RuntimeSandbox,
} from "../src/docker/runtime.js";
import { openSandboxStore } from "../src/persistence/store.js";

class FakeRuntime implements ContainerRuntime {
  readonly sandboxes = new Map<string, RuntimeSandbox>();
  readonly removedVolumes: string[] = [];

  async ping() {}

  async create(spec: CreateRuntimeSandbox) {
    const sandbox: RuntimeSandbox = {
      sandboxId: spec.id,
      containerId: `container-${spec.id}`,
      stateVolume: spec.stateVolume,
      state: "running",
      sshHostPort: 49_152,
      sshHostPublicKey:
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKey gateway-test",
    };
    this.sandboxes.set(spec.id, sandbox);
    return sandbox;
  }

  async inspect(id: string) {
    return this.sandboxes.get(id) ?? null;
  }

  async listManaged() {
    return [...this.sandboxes.values()];
  }

  async start(id: string) {
    const sandbox = this.sandboxes.get(id);
    if (sandbox) sandbox.state = "running";
  }

  async stop(id: string) {
    const sandbox = this.sandboxes.get(id);
    if (sandbox) sandbox.state = "stopped";
  }

  async remove(id: string) {
    this.sandboxes.delete(id);
  }

  async removeVolume(name: string) {
    this.removedVolumes.push(name);
  }

  async logs() {
    return Readable.from(["sandbox ready\n"]);
  }
}

const publicKey =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIClientKeyForTest agentctl";

test("authenticated users can manage a sandbox lifecycle", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-control-gateway-"));
  const store = openSandboxStore(join(directory, "gateway.db"));
  const runtime = new FakeRuntime();
  const app = buildApp({ store, runtime, token: "test-token" });

  t.after(async () => {
    await app.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const unauthorized = await app.inject({
    method: "GET",
    url: "/v1/sandboxes",
  });
  assert.equal(unauthorized.statusCode, 401);

  const created = await app.inject({
    method: "POST",
    url: "/v1/sandboxes",
    headers: { authorization: "Bearer test-token" },
    payload: {
      name: "demo",
      publicKey,
      command: ["codex"],
    },
  });

  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().data.name, "demo");
  assert.equal(created.json().data.observedState, "running");

  const duplicate = await app.inject({
    method: "POST",
    url: "/v1/sandboxes",
    headers: { authorization: "Bearer test-token" },
    payload: { name: "demo", publicKey },
  });
  assert.equal(duplicate.statusCode, 409);

  const listed = await app.inject({
    method: "GET",
    url: "/v1/sandboxes",
    headers: { authorization: "Bearer test-token" },
  });
  assert.equal(listed.json().data.length, 1);

  const id = created.json().data.id as string;
  const stopped = await app.inject({
    method: "POST",
    url: `/v1/sandboxes/${id}/stop`,
    headers: { authorization: "Bearer test-token" },
  });
  assert.equal(stopped.json().data.observedState, "stopped");

  const started = await app.inject({
    method: "POST",
    url: `/v1/sandboxes/${id}/start`,
    headers: { authorization: "Bearer test-token" },
  });
  assert.equal(started.json().data.observedState, "running");

  const connection = await app.inject({
    method: "GET",
    url: `/v1/sandboxes/${id}/connection`,
    headers: { authorization: "Bearer test-token" },
  });
  assert.equal(connection.json().data.port, 49_152);

  const removed = await app.inject({
    method: "DELETE",
    url: `/v1/sandboxes/${id}?deleteVolume=true`,
    headers: { authorization: "Bearer test-token" },
  });
  assert.equal(removed.json().data.observedState, "deleted");
  assert.equal(runtime.removedVolumes.length, 1);
});

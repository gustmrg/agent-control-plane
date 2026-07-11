import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { mergeOpenCodeAuth, ProfileService } from "../src/profiles/service.js";
import { SandboxService } from "../src/sandboxes/service.js";
import { createSecretCipher } from "../src/secrets/crypto.js";
import { LocalSecretBackend } from "../src/secrets/local-backend.js";
import { SecretService } from "../src/secrets/service.js";

class NoopRuntime implements ContainerRuntime {
  async ping() {}
  async create(_spec: CreateRuntimeSandbox): Promise<RuntimeSandbox> {
    throw new Error("not used");
  }
  async inspect() {
    return null;
  }
  async listManaged() {
    return [];
  }
  async start() {}
  async stop() {}
  async remove() {}
  async removeVolume() {}
  async readStateFile() {
    return null;
  }
  async logs() {
    return Readable.from([]);
  }
}

class AuthRuntime implements ContainerRuntime {
  readonly sandboxes = new Map<string, RuntimeSandbox>();
  readonly files = new Map<string, Map<string, Buffer>>();
  async ping() {}
  async create(spec: CreateRuntimeSandbox): Promise<RuntimeSandbox> {
    const runtime: RuntimeSandbox = {
      sandboxId: spec.id,
      containerId: `container-${spec.id}`,
      stateVolume: spec.stateVolume,
      state: "running",
      sshHostPort: 49152,
      sshHostPublicKey: "ssh-ed25519 AAAAC3NzaFake",
    };
    this.sandboxes.set(spec.id, runtime);
    this.files.set(
      spec.id,
      new Map(
        spec.bootstrapFiles?.map((file) => [file.path, file.content]) ?? [],
      ),
    );
    return runtime;
  }
  async inspect(id: string) {
    return this.sandboxes.get(id) ?? null;
  }
  async listManaged() {
    return [...this.sandboxes.values()];
  }
  async start(id: string) {
    const runtime = this.sandboxes.get(id);
    if (runtime) runtime.state = "running";
  }
  async stop(id: string) {
    const runtime = this.sandboxes.get(id);
    if (runtime) runtime.state = "stopped";
  }
  async remove(id: string) {
    this.sandboxes.delete(id);
  }
  async removeVolume() {}
  async readStateFile(id: string, path: string) {
    return this.files.get(id)?.get(path) ?? null;
  }
  async logs() {
    return Readable.from([]);
  }
}

const authorization = { authorization: "Bearer test-token" };

const bundle = (path = ".codex/config.toml") =>
  Buffer.from(
    JSON.stringify({
      version: 1,
      files: [
        {
          path,
          contentBase64: Buffer.from('model = "gpt-5"\n').toString("base64"),
          mode: 0o600,
        },
      ],
    }),
  ).toString("base64");

test("AES-GCM authenticates ciphertext and its context", () => {
  const cipher = createSecretCipher(Buffer.alloc(32, 7));
  const encrypted = cipher.encrypt(Buffer.from("sensitive"), "secret:a");
  assert.equal(cipher.decrypt(encrypted, "secret:a").toString(), "sensitive");

  assert.throws(() =>
    cipher.decrypt(
      {
        ...encrypted,
        ciphertext: Buffer.from(encrypted.ciphertext).fill(0, 0, 1),
      },
      "secret:a",
    ),
  );
  assert.throws(() => cipher.decrypt(encrypted, "secret:b"));
  assert.throws(() =>
    createSecretCipher(Buffer.alloc(32, 8)).decrypt(encrypted, "secret:a"),
  );
});

test("secret endpoints are unavailable without a configured backend", async (t) => {
  const store = openSandboxStore(":memory:");
  const app = buildApp({
    store,
    runtime: new NoopRuntime(),
    token: "test-token",
  });
  t.after(async () => {
    await app.close();
    store.close();
  });

  const response = await app.inject({
    method: "GET",
    url: "/v1/secrets",
    headers: authorization,
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "secrets_not_configured");
});

test("secret uploads reject non-loopback plain HTTP", async (t) => {
  const store = openSandboxStore(":memory:");
  const cipher = createSecretCipher(Buffer.alloc(32, 15));
  const app = buildApp({
    store,
    runtime: new NoopRuntime(),
    token: "test-token",
    secretCipher: cipher,
    secretBackend: new LocalSecretBackend(store, cipher),
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const response = await app.inject({
    method: "PUT",
    url: "/v1/secrets/plain-http",
    headers: { ...authorization, host: "gateway.example.test" },
    payload: {
      type: "opaque",
      valueBase64: Buffer.from("secret").toString("base64"),
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, "insecure_secret_transport");
});

test("secrets and immutable profile versions expose metadata only", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-control-secrets-"));
  const filename = join(directory, "gateway.db");
  const store = openSandboxStore(filename);
  const cipher = createSecretCipher(Buffer.alloc(32, 9));
  const backend = new LocalSecretBackend(store, cipher);
  const app = buildApp({
    store,
    runtime: new NoopRuntime(),
    token: "test-token",
    secretCipher: cipher,
    secretBackend: backend,
  });
  t.after(async () => {
    await app.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const secretValue = "do-not-leak-this-refresh-token";
  const createdSecret = await app.inject({
    method: "PUT",
    url: "/v1/secrets/codex-personal",
    headers: authorization,
    payload: {
      type: "codex-auth",
      valueBase64: Buffer.from(secretValue).toString("base64"),
    },
  });
  assert.equal(createdSecret.statusCode, 200, createdSecret.body);
  assert.equal(createdSecret.json().data.version, 1);
  assert.doesNotMatch(createdSecret.body, /valueBase64|do-not-leak/);

  const listedSecrets = await app.inject({
    method: "GET",
    url: "/v1/secrets",
    headers: authorization,
  });
  assert.equal(listedSecrets.json().data.length, 1);
  assert.doesNotMatch(listedSecrets.body, /valueBase64|do-not-leak/);

  const profile = await app.inject({
    method: "PUT",
    url: "/v1/profiles/codex-personal",
    headers: authorization,
    payload: {
      agent: "codex",
      bundleBase64: bundle(),
      secretNames: ["codex-personal"],
    },
  });
  assert.equal(profile.statusCode, 200, profile.body);
  assert.equal(profile.json().data.version, 1);
  assert.equal(profile.json().data.credentials[0].type, "codex-auth");

  const nextVersion = await app.inject({
    method: "PUT",
    url: "/v1/profiles/codex-personal",
    headers: authorization,
    payload: {
      agent: "codex",
      bundleBase64: bundle(),
      secretNames: ["codex-personal"],
    },
  });
  assert.equal(nextVersion.json().data.version, 2);
  assert.ok(store.getProfileVersion("codex-personal", 1));
  assert.ok(store.getProfileVersion("codex-personal", 2));

  const defaultProfile = await app.inject({
    method: "PUT",
    url: "/v1/profiles/defaults/codex",
    headers: authorization,
    payload: { profileName: "codex-personal" },
  });
  assert.equal(defaultProfile.statusCode, 200, defaultProfile.body);
  assert.equal(defaultProfile.json().data.isDefault, true);

  const blockedDelete = await app.inject({
    method: "DELETE",
    url: "/v1/secrets/codex-personal",
    headers: authorization,
  });
  assert.equal(blockedDelete.statusCode, 409);
  assert.equal(blockedDelete.json().error.code, "secret_in_use");

  for (const path of [filename, `${filename}-wal`, `${filename}-shm`]) {
    assert.doesNotMatch(
      readFileSync(path).toString("latin1"),
      new RegExp(secretValue),
    );
  }
});

test("profiles reject incompatible credentials and unsafe bundle paths", async (t) => {
  const store = openSandboxStore(":memory:");
  const cipher = createSecretCipher(Buffer.alloc(32, 10));
  const backend = new LocalSecretBackend(store, cipher);
  const app = buildApp({
    store,
    runtime: new NoopRuntime(),
    token: "test-token",
    secretCipher: cipher,
    secretBackend: backend,
  });
  t.after(async () => {
    await app.close();
    store.close();
  });

  await app.inject({
    method: "PUT",
    url: "/v1/secrets/opencode-go",
    headers: authorization,
    payload: {
      type: "opencode-go-key",
      valueBase64: Buffer.from("go-key").toString("base64"),
    },
  });

  const incompatible = await app.inject({
    method: "PUT",
    url: "/v1/profiles/wrong-agent",
    headers: authorization,
    payload: {
      agent: "codex",
      bundleBase64: bundle(),
      secretNames: ["opencode-go"],
    },
  });
  assert.equal(incompatible.statusCode, 400);
  assert.equal(incompatible.json().error.code, "incompatible_profile_secret");

  const unsafe = await app.inject({
    method: "PUT",
    url: "/v1/profiles/unsafe",
    headers: authorization,
    payload: {
      agent: "codex",
      bundleBase64: bundle("../auth.json"),
      secretNames: [],
    },
  });
  assert.equal(unsafe.statusCode, 400);
  assert.equal(unsafe.json().error.code, "invalid_profile_path");
});

test("secret versions use optimistic concurrency", () => {
  const store = openSandboxStore(":memory:");
  const cipher = createSecretCipher(Buffer.alloc(32, 11));
  const backend = new LocalSecretBackend(store, cipher);
  try {
    backend.put("versioned", "opaque", Buffer.from("one"));
    backend.put("versioned", "opaque", Buffer.from("two"), 1);
    assert.throws(
      () => backend.put("versioned", "opaque", Buffer.from("stale"), 1),
      /has changed/,
    );
    assert.equal(backend.get("versioned")?.value.toString(), "two");
  } finally {
    store.close();
  }
});

test("profiles pin versions, bootstrap subscription auth, lease OAuth, and write back", async (t) => {
  const store = openSandboxStore(":memory:");
  const cipher = createSecretCipher(Buffer.alloc(32, 12));
  const backend = new LocalSecretBackend(store, cipher);
  const runtime = new AuthRuntime();
  const app = buildApp({
    store,
    runtime,
    token: "test-token",
    secretCipher: cipher,
    secretBackend: backend,
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const request = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: authorization,
      ...(payload ? { payload } : {}),
    });

  const initialAuth = {
    auth_mode: "chatgpt",
    tokens: { refresh_token: "initial" },
  };
  await request("PUT", "/v1/secrets/codex-subscription", {
    type: "codex-auth",
    valueBase64: Buffer.from(JSON.stringify(initialAuth)).toString("base64"),
  });
  await request("PUT", "/v1/profiles/codex-main", {
    agent: "codex",
    bundleBase64: bundle(),
    secretNames: ["codex-subscription"],
  });
  await request("PUT", "/v1/profiles/defaults/codex", {
    profileName: "codex-main",
  });
  const first = await request("POST", "/v1/sandboxes", {
    name: "first",
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIClientKeyForTest agentctl",
    command: ["codex"],
  });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().data.profileName, "codex-main");
  assert.equal(first.json().data.profileVersion, 1);
  const firstId = first.json().data.id as string;
  assert.deepEqual(
    JSON.parse(runtime.files.get(firstId)!.get(".codex/auth.json")!.toString()),
    initialAuth,
  );

  await request("PUT", "/v1/profiles/codex-main", {
    agent: "codex",
    bundleBase64: bundle(),
    secretNames: ["codex-subscription"],
  });
  assert.equal(store.get(firstId)?.profileVersion, 1);

  const conflict = await request("POST", "/v1/sandboxes", {
    name: "second",
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIClientKeyForTest agentctl",
    command: ["codex"],
  });
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.match(conflict.json().error.message, /sandbox 'first'/);

  const refreshed = {
    auth_mode: "chatgpt",
    tokens: { refresh_token: "refreshed" },
  };
  runtime.files
    .get(firstId)!
    .set(".codex/auth.json", Buffer.from(JSON.stringify(refreshed)));
  const stopped = await request("POST", `/v1/sandboxes/${firstId}/stop`);
  assert.equal(stopped.statusCode, 200, stopped.body);
  assert.deepEqual(
    JSON.parse(backend.get("codex-subscription")!.value.toString()),
    refreshed,
  );
  assert.equal(store.listSecretLeases().length, 0);

  const retried = await request("POST", "/v1/sandboxes", {
    name: "second",
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIClientKeyForTest agentctl",
    command: ["codex"],
  });
  assert.equal(retried.statusCode, 201, retried.body);
  assert.equal(retried.json().data.profileVersion, 2);
});

test("OpenCode Go subscription is shared and unmanaged auth providers are preserved", async (t) => {
  const store = openSandboxStore(":memory:");
  const cipher = createSecretCipher(Buffer.alloc(32, 13));
  const backend = new LocalSecretBackend(store, cipher);
  const runtime = new AuthRuntime();
  const app = buildApp({
    store,
    runtime,
    token: "test-token",
    secretCipher: cipher,
    secretBackend: backend,
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const request = (
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: authorization,
      ...(payload ? { payload } : {}),
    });
  await request("PUT", "/v1/secrets/opencode-go-subscription", {
    type: "opencode-go-key",
    valueBase64: Buffer.from(
      JSON.stringify({ type: "api", key: "go-key" }),
    ).toString("base64"),
  });
  await request("PUT", "/v1/profiles/opencode-go", {
    agent: "opencode",
    bundleBase64: Buffer.from(
      JSON.stringify({ version: 1, files: [] }),
    ).toString("base64"),
    secretNames: ["opencode-go-subscription"],
  });
  for (const name of ["go-one", "go-two"]) {
    const created = await request("POST", "/v1/sandboxes", {
      name,
      profileName: "opencode-go",
      publicKey:
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIClientKeyForTest agentctl",
      command: ["opencode"],
    });
    assert.equal(created.statusCode, 201, created.body);
  }
  assert.equal(store.listSecretLeases().length, 0);
  const merged = mergeOpenCodeAuth(
    Buffer.from(JSON.stringify({ github: { type: "oauth", refresh: "keep" } })),
    [
      {
        type: "opencode-go-key",
        value: Buffer.from(JSON.stringify({ type: "api", key: "go" })),
      },
    ],
  );
  assert.deepEqual(JSON.parse(merged.toString()), {
    github: { type: "oauth", refresh: "keep" },
    "opencode-go": { type: "api", key: "go" },
  });
});

test("write-back failure leaves the sandbox stopped and retains the OAuth lease", async (t) => {
  const store = openSandboxStore(":memory:");
  const cipher = createSecretCipher(Buffer.alloc(32, 14));
  const backend = new LocalSecretBackend(store, cipher);
  const runtime = new AuthRuntime();
  const app = buildApp({
    store,
    runtime,
    token: "test-token",
    secretCipher: cipher,
    secretBackend: backend,
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  await app.inject({
    method: "PUT",
    url: "/v1/secrets/codex-auth",
    headers: authorization,
    payload: {
      type: "codex-auth",
      valueBase64: Buffer.from(
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { refresh_token: "one" },
        }),
      ).toString("base64"),
    },
  });
  await app.inject({
    method: "PUT",
    url: "/v1/profiles/codex-failure",
    headers: authorization,
    payload: {
      agent: "codex",
      bundleBase64: bundle(),
      secretNames: ["codex-auth"],
    },
  });
  const created = await app.inject({
    method: "POST",
    url: "/v1/sandboxes",
    headers: authorization,
    payload: {
      name: "writeback-failure",
      profileName: "codex-failure",
      publicKey:
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIClientKeyForTest agentctl",
      command: ["codex"],
    },
  });
  const id = created.json().data.id as string;
  runtime.files.get(id)!.delete(".codex/auth.json");

  const stopped = await app.inject({
    method: "POST",
    url: `/v1/sandboxes/${id}/stop`,
    headers: authorization,
  });
  assert.equal(stopped.statusCode, 502, stopped.body);
  assert.equal(runtime.sandboxes.get(id)?.state, "stopped");
  assert.equal(store.listSecretLeases()[0]?.sandboxId, id);
  assert.match(
    store.get(id)?.lastError ?? "",
    /authentication file is missing/,
  );
});

test("reconciliation retains running and missing leases but syncs stopped sandboxes", async (t) => {
  const store = openSandboxStore(":memory:");
  const cipher = createSecretCipher(Buffer.alloc(32, 16));
  const backend = new LocalSecretBackend(store, cipher);
  const runtime = new AuthRuntime();
  const app = buildApp({
    store,
    runtime,
    token: "test-token",
    secretCipher: cipher,
    secretBackend: backend,
  });
  const reconciler = new SandboxService({
    store,
    runtime,
    profiles: new ProfileService(store, new SecretService(backend), cipher),
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  await app.inject({
    method: "PUT",
    url: "/v1/secrets/reconcile-auth",
    headers: authorization,
    payload: {
      type: "codex-auth",
      valueBase64: Buffer.from(
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { refresh_token: "initial" },
        }),
      ).toString("base64"),
    },
  });
  await app.inject({
    method: "PUT",
    url: "/v1/profiles/reconcile-profile",
    headers: authorization,
    payload: {
      agent: "codex",
      bundleBase64: bundle(),
      secretNames: ["reconcile-auth"],
    },
  });
  const created = await app.inject({
    method: "POST",
    url: "/v1/sandboxes",
    headers: authorization,
    payload: {
      name: "reconcile-sandbox",
      profileName: "reconcile-profile",
      publicKey:
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIClientKeyForTest agentctl",
      command: ["codex"],
    },
  });
  const id = created.json().data.id as string;

  await reconciler.reconcile();
  assert.equal(store.listSecretLeases()[0]?.sandboxId, id);

  runtime.sandboxes.get(id)!.state = "stopped";
  runtime.files.get(id)!.set(
    ".codex/auth.json",
    Buffer.from(
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { refresh_token: "reconciled" },
      }),
    ),
  );
  await reconciler.reconcile();
  assert.equal(store.listSecretLeases().length, 0);
  assert.equal(backend.get("reconcile-auth")?.metadata.version, 2);

  await app.inject({
    method: "POST",
    url: `/v1/sandboxes/${id}/start`,
    headers: authorization,
  });
  runtime.sandboxes.delete(id);
  await reconciler.reconcile();
  assert.equal(store.listSecretLeases()[0]?.sandboxId, id);
  assert.equal(store.get(id)?.lastError, "Managed container is missing");
});

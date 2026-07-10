import assert from "node:assert/strict";
import test from "node:test";

import {
  createSandboxRequestSchema,
  deleteSandboxQuerySchema,
  hostConfigSchema,
} from "../src/index.js";

test("accepts a sandbox request with a trailing agent command", () => {
  const result = createSandboxRequestSchema.parse({
    name: "bill-fix",
    repositoryUrl: "https://github.com/example/project.git",
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest agentctl",
    command: ["codex", "--full-auto"],
  });

  assert.deepEqual(result.command, ["codex", "--full-auto"]);
  assert.equal(result.name, "bill-fix");
});

test("rejects unsafe sandbox names and non-HTTPS repositories", () => {
  const result = createSandboxRequestSchema.safeParse({
    name: "../../root",
    repositoryUrl: "file:///etc/passwd",
    publicKey: "not-a-key",
  });

  assert.equal(result.success, false);
});

test("accepts direct and SSH host registrations", () => {
  assert.equal(
    hostConfigSchema.parse({
      transport: "direct",
      apiEndpoint: "http://127.0.0.1:7070",
      token: "secret",
    }).transport,
    "direct",
  );

  assert.equal(
    hostConfigSchema.parse({
      transport: "ssh",
      sshTarget: "homelab",
      apiAddress: "127.0.0.1:7070",
      token: "secret",
    }).transport,
    "ssh",
  );
});

test("parses false query strings without treating them as truthy", () => {
  assert.equal(
    deleteSandboxQuerySchema.parse({ deleteVolume: "false" }).deleteVolume,
    false,
  );
  assert.equal(
    deleteSandboxQuerySchema.parse({ deleteVolume: "true" }).deleteVolume,
    true,
  );
});

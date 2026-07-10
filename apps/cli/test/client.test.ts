import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ClientConfig, HostConfig } from "@agent-control/contracts";

import { loadConfig, resolveHost, saveConfig } from "../src/config.js";
import { configFile } from "../src/paths.js";
import { buildSandboxSshArgs } from "../src/ssh.js";

const direct: HostConfig = {
  transport: "direct",
  apiEndpoint: "http://127.0.0.1:7070",
  token: "direct-token",
};
const remote: HostConfig = {
  transport: "ssh",
  sshTarget: "homelab",
  apiAddress: "127.0.0.1:7070",
  token: "remote-token",
};
const config: ClientConfig = {
  activeHost: "home",
  hosts: { local: direct, home: remote },
};

test("host resolution prefers a flag, then environment, then the active host", () => {
  assert.equal(resolveHost(config, "local", "home").name, "local");
  assert.equal(resolveHost(config, undefined, "local").name, "local");
  assert.equal(resolveHost(config).name, "home");
});

test("remote sandbox SSH uses the saved SSH alias as a jump host", () => {
  const args = buildSandboxSshArgs({
    hostName: "home",
    host: remote,
    connection: {
      sandboxId: "9310a32d-6d3f-4aaf-a40f-437514783e3e",
      sandboxName: "demo",
      user: "sandbox",
      host: "127.0.0.1",
      port: 49_152,
      hostPublicKey:
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestHostKey agentctl",
    },
    identityFile: "/tmp/agentctl-key",
    knownHostsFile: "/tmp/agentctl-known-hosts",
    command: ["printf", "%s", "hello world"],
  });

  assert.deepEqual(args.slice(0, 2), ["-J", "homelab"]);
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.equal(args.at(-1), "'printf' '%s' 'hello world'");
});

test("host configuration round-trips through an owner-only TOML file", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-control-cli-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  });

  saveConfig(config);

  assert.deepEqual(loadConfig(), config);
  assert.equal(statSync(configFile()).mode & 0o777, 0o600);
});

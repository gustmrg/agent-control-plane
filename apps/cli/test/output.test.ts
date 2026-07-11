import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";

import type { Sandbox } from "@agent-control/contracts";

import {
  createOutputContext,
  printError,
  printSandbox,
  printSandboxes,
} from "../src/output.js";

class MemoryStream extends Writable {
  readonly chunks: string[] = [];

  constructor(readonly isTTY: boolean) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.chunks.push(chunk.toString());
    callback();
  }

  text() {
    return this.chunks.join("");
  }
}

const sandbox: Sandbox = {
  id: "9310a32d-6d3f-4aaf-a40f-437514783e3e",
  name: "demo",
  image: "agent-control-sandbox:latest",
  repositoryUrl: "https://github.com/example/project.git",
  command: ["codex"],
  desiredState: "deleted",
  observedState: "deleted",
  containerId: null,
  stateVolume: "agent-control-state-demo",
  sshHostPort: null,
  createdAt: "2026-07-10T18:35:18.085Z",
  updatedAt: "2026-07-10T19:35:18.085Z",
  deletedAt: "2026-07-10T19:35:18.085Z",
  lastError: null,
  profileName: null,
  profileVersion: null,
};

const context = (
  options: {
    tty?: boolean;
    json?: boolean;
    noColor?: boolean;
    noColorEnv?: boolean;
  } = {},
) => {
  const stdout = new MemoryStream(options.tty ?? false);
  const stderr = new MemoryStream(options.tty ?? false);
  return {
    stdout,
    stderr,
    value: createOutputContext({
      format: options.json ? "json" : "table",
      ...(options.noColor === undefined ? {} : { noColor: options.noColor }),
      stdout,
      stderr,
      env: options.noColorEnv ? { NO_COLOR: "1" } : {},
    }),
  };
};

test("human delete output omits Created and reports volume disposition", () => {
  const output = context();
  printSandbox(sandbox, output.value, {
    operation: "delete",
    deleteVolume: false,
  });

  assert.match(output.stdout.text(), /Sandbox 'demo' deleted/);
  assert.match(output.stdout.text(), /Volume:\s+preserved/);
  assert.doesNotMatch(output.stdout.text(), /Created/);
  assert.doesNotMatch(output.stdout.text(), /2026-07-10T18:35/);
});

test("create/get are detailed while start/stop are concise", () => {
  const created = context();
  printSandbox({ ...sandbox, observedState: "running" }, created.value, {
    operation: "create",
  });
  assert.match(created.stdout.text(), /Sandbox 'demo' created/);
  assert.match(created.stdout.text(), /Repository:/);
  assert.match(created.stdout.text(), /Created\s+:/);

  const inspected = context();
  printSandbox(sandbox, inspected.value, { operation: "get" });
  assert.doesNotMatch(inspected.stdout.text(), /^✓/);
  assert.match(inspected.stdout.text(), /Created\s+:/);

  for (const [operation, verb] of [
    ["start", "started"],
    ["stop", "stopped"],
  ] as const) {
    const changed = context();
    printSandbox(sandbox, changed.value, { operation });
    assert.match(changed.stdout.text(), new RegExp(verb));
    assert.doesNotMatch(changed.stdout.text(), /Created\s+:/);
  }
});

test("JSON delete output preserves the complete sandbox without ANSI", () => {
  const output = context({ tty: true, json: true });
  printSandbox(sandbox, output.value, {
    operation: "delete",
    deleteVolume: true,
  });

  assert.equal(JSON.parse(output.stdout.text()).createdAt, sandbox.createdAt);
  assert.doesNotMatch(output.stdout.text(), /\u001b\[/);
});

test("sandbox tables color states only for an enabled TTY", () => {
  const colored = context({ tty: true });
  printSandboxes([{ ...sandbox, observedState: "running" }], colored.value);
  assert.match(colored.stdout.text(), /\u001b\[/);
  assert.match(colored.stdout.text(), /running/);

  const redirected = context();
  printSandboxes([{ ...sandbox, observedState: "running" }], redirected.value);
  assert.doesNotMatch(redirected.stdout.text(), /\u001b\[/);
});

test("NO_COLOR and --no-color disable ANSI on TTY output", () => {
  for (const output of [
    context({ tty: true, noColor: true }),
    context({ tty: true, noColorEnv: true }),
  ]) {
    printSandboxes([sandbox], output.value);
    assert.doesNotMatch(output.stdout.text(), /\u001b\[/);
  }
});

test("errors include API codes on stderr without leaking to stdout", () => {
  const output = context();
  printError(new Error("Sandbox is busy"), output.value, "secret_in_use");

  assert.equal(output.stdout.text(), "");
  assert.equal(output.stderr.text(), "✗ [secret_in_use] Sandbox is busy\n");
});

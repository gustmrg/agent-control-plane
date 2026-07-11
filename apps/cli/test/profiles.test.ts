import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { credentialName, importLocalProfile } from "../src/profiles.js";

const writeJson = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

test("imports Codex config, global skills, and ChatGPT subscription auth", () => {
  const home = mkdtempSync(join(tmpdir(), "agentctl-codex-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "model = 'gpt-5'\n");
  mkdirSync(join(home, ".agents", "skills", "demo"), { recursive: true });
  writeFileSync(
    join(home, ".agents", "skills", "demo", "SKILL.md"),
    "# Demo\n",
  );
  writeJson(join(home, ".codex", "auth.json"), {
    auth_mode: "chatgpt",
    tokens: { refresh_token: "refresh" },
  });

  const imported = importLocalProfile("codex", true, { home, env: {} });
  const bundle = JSON.parse(
    Buffer.from(imported.bundleBase64, "base64").toString(),
  );
  assert.deepEqual(
    bundle.files.map((file: { path: string }) => file.path),
    [".agents/skills/demo/SKILL.md", ".codex/config.toml"],
  );
  assert.deepEqual(
    imported.credentials.map(({ type }) => type),
    ["codex-auth"],
  );
});

test("rejects Codex API-key auth", () => {
  const home = mkdtempSync(join(tmpdir(), "agentctl-codex-key-"));
  writeJson(join(home, ".codex", "auth.json"), { auth_mode: "apikey" });
  assert.throws(
    () => importLocalProfile("codex", true, { home, env: {} }),
    /ChatGPT auth/,
  );
});

test("splits OpenAI OAuth and OpenCode Go subscription credentials", () => {
  const home = mkdtempSync(join(tmpdir(), "agentctl-opencode-"));
  writeJson(join(home, ".local", "share", "opencode", "auth.json"), {
    openai: { type: "oauth", refresh: "refresh", access: "access" },
    "opencode-go": { type: "api", key: "go-subscription" },
    github: { type: "oauth", refresh: "unmanaged" },
  });
  const imported = importLocalProfile("opencode", true, { home, env: {} });
  assert.deepEqual(imported.credentials.map(({ type }) => type).sort(), [
    "opencode-go-key",
    "opencode-openai-oauth",
  ]);
});

test("rejects OpenAI API keys", () => {
  const home = mkdtempSync(join(tmpdir(), "agentctl-opencode-key-"));
  writeJson(join(home, ".local", "share", "opencode", "auth.json"), {
    openai: { type: "api", key: "not-supported" },
  });
  assert.throws(
    () => importLocalProfile("opencode", true, { home, env: {} }),
    /API keys are not supported/,
  );
});

test("rejects symlinks and keeps derived credential names valid", () => {
  const home = mkdtempSync(join(tmpdir(), "agentctl-symlink-"));
  mkdirSync(join(home, ".agents", "skills"), { recursive: true });
  writeFileSync(join(home, "target"), "secret");
  symlinkSync(join(home, "target"), join(home, ".agents", "skills", "link"));
  assert.throws(
    () => importLocalProfile("codex", false, { home, env: {} }),
    /symlinks/,
  );
  assert.match(
    credentialName("a".repeat(63), "opencode-go"),
    /^[a-z][a-z0-9-]{0,62}$/,
  );
});

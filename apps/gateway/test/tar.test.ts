import assert from "node:assert/strict";
import test from "node:test";

import {
  firstArchiveFile,
  mergeJsonStateFile,
  stateArchive,
} from "../src/docker/tar.js";

const octalAt = (archive: Buffer, offset: number, length: number) =>
  Number.parseInt(
    archive
      .subarray(offset, offset + length)
      .toString("ascii")
      .replace(/\0.*$/, "")
      .trim(),
    8,
  );

test("bootstrap archives assign sandbox ownership and restrictive auth modes", () => {
  const content = Buffer.from('{"auth":"subscription"}');
  const archive = stateArchive([
    { path: ".codex/auth.json", content, mode: 0o600 },
  ]);
  const fileOffset = 512;
  assert.equal(octalAt(archive, fileOffset + 100, 8), 0o600);
  assert.equal(octalAt(archive, fileOffset + 108, 8), 1000);
  assert.equal(octalAt(archive, fileOffset + 116, 8), 1000);
  assert.deepEqual(firstArchiveFile(archive), content);
  assert.doesNotMatch(
    archive.subarray(fileOffset, fileOffset + 512).toString("utf8"),
    /subscription/,
  );
});

test("bootstrap archives support USTAR paths longer than 100 bytes", () => {
  const path = `.agents/skills/${"nested/".repeat(13)}SKILL.md`;
  const archive = stateArchive([
    { path, content: Buffer.from("skill"), mode: 0o644 },
  ]);
  assert.deepEqual(firstArchiveFile(archive), Buffer.from("skill"));
});

test("JSON state merge preserves unmanaged providers and replaces managed providers", () => {
  const merged = mergeJsonStateFile(
    Buffer.from(
      JSON.stringify({
        github: { type: "oauth", refresh: "keep" },
        openai: { type: "oauth", refresh: "stale" },
        "opencode-go": { type: "api", key: "stale" },
      }),
    ),
    Buffer.from(
      JSON.stringify({ "opencode-go": { type: "api", key: "current" } }),
    ),
    ["openai", "opencode-go"],
    ".local/share/opencode/auth.json",
  );
  assert.deepEqual(JSON.parse(merged.toString()), {
    github: { type: "oauth", refresh: "keep" },
    "opencode-go": { type: "api", key: "current" },
  });
});

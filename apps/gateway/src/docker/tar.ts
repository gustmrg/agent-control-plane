import { posix } from "node:path";

import type { StateFile } from "./runtime.js";

const block = 512;

const octal = (value: number, length: number) =>
  `${value.toString(8).padStart(length - 1, "0")}\0`;

const header = (path: string, size: number, mode: number, type: "0" | "5") => {
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const split = path.lastIndexOf(
      "/",
      path.length - (path.endsWith("/") ? 2 : 1),
    );
    if (split < 1)
      throw new Error(
        `State path is too long for the bootstrap archive: ${path}`,
      );
    prefix = path.slice(0, split);
    name = path.slice(split + 1);
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155)
      throw new Error(
        `State path is too long for the bootstrap archive: ${path}`,
      );
  }
  const value = Buffer.alloc(block);
  value.write(name, 0, 100, "utf8");
  value.write(octal(mode, 8), 100, 8, "ascii");
  value.write(octal(1000, 8), 108, 8, "ascii");
  value.write(octal(1000, 8), 116, 8, "ascii");
  value.write(octal(size, 12), 124, 12, "ascii");
  value.write(octal(Math.floor(Date.now() / 1000), 12), 136, 12, "ascii");
  value.fill(0x20, 148, 156);
  value.write(type, 156, 1, "ascii");
  value.write("ustar\0", 257, 6, "ascii");
  value.write("00", 263, 2, "ascii");
  value.write("sandbox", 265, 32, "ascii");
  value.write("sandbox", 297, 32, "ascii");
  value.write(prefix, 345, 155, "utf8");
  const checksum = value.reduce((sum, byte) => sum + byte, 0);
  value.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return value;
};

export const stateArchive = (files: StateFile[]) => {
  const directories = new Set<string>();
  for (const file of files) {
    let directory = posix.dirname(file.path);
    while (directory !== ".") {
      directories.add(directory);
      directory = posix.dirname(directory);
    }
  }
  const chunks: Buffer[] = [];
  for (const directory of [...directories].sort())
    chunks.push(header(`${directory}/`, 0, 0o700, "5"));
  for (const file of files) {
    chunks.push(header(file.path, file.content.byteLength, file.mode, "0"));
    chunks.push(file.content);
    const padding = (block - (file.content.byteLength % block)) % block;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(block * 2));
  return Buffer.concat(chunks);
};

export const firstArchiveFile = (archive: Buffer) => {
  let offset = 0;
  while (offset + block <= archive.length) {
    const entry = archive.subarray(offset, offset + block);
    if (entry.every((byte) => byte === 0)) return null;
    const size = Number.parseInt(
      entry.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() ||
        "0",
      8,
    );
    const type = entry.subarray(156, 157).toString("ascii");
    const content = archive.subarray(offset + block, offset + block + size);
    if (type === "0" || type === "\0") return Buffer.from(content);
    offset += block + Math.ceil(size / block) * block;
  }
  return null;
};

export const mergeJsonStateFile = (
  existing: Buffer,
  managedContent: Buffer,
  managedKeys: string[],
  path: string,
) => {
  let previous: unknown;
  let managed: unknown;
  try {
    previous = JSON.parse(existing.toString("utf8"));
    managed = JSON.parse(managedContent.toString("utf8"));
  } catch {
    throw new Error(`Existing state file is not valid JSON: ${path}`);
  }
  if (
    !previous ||
    typeof previous !== "object" ||
    Array.isArray(previous) ||
    !managed ||
    typeof managed !== "object" ||
    Array.isArray(managed)
  )
    throw new Error(`State file must contain a JSON object: ${path}`);
  const merged = { ...(previous as Record<string, unknown>) };
  for (const key of managedKeys) delete merged[key];
  Object.assign(merged, managed);
  return Buffer.from(JSON.stringify(merged));
};

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import type { DesiredState } from "@agent-control/contracts";

export type SandboxRecord = {
  id: string;
  name: string;
  image: string;
  repositoryUrl: string | null;
  command: string[];
  desiredState: DesiredState;
  containerId: string | null;
  stateVolume: string;
  sshHostPort: number | null;
  sshHostPublicKey: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  lastError: string | null;
};

type DatabaseRow = {
  id: string;
  name: string;
  image: string;
  repository_url: string | null;
  initial_command_json: string;
  desired_state: DesiredState;
  container_id: string | null;
  state_volume: string;
  ssh_host_port: number | null;
  ssh_host_public_key: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  last_error: string | null;
};

export type SandboxStore = {
  close(): void;
  ping(): void;
  create(record: SandboxRecord): SandboxRecord;
  list(includeDeleted?: boolean): SandboxRecord[];
  get(idOrName: string): SandboxRecord | null;
  update(id: string, changes: Partial<SandboxRecord>): SandboxRecord;
};

const migrationsDirectory = fileURLToPath(
  new URL("../../migrations/", import.meta.url),
);

const toRecord = (row: DatabaseRow): SandboxRecord => ({
  id: row.id,
  name: row.name,
  image: row.image,
  repositoryUrl: row.repository_url,
  command: JSON.parse(row.initial_command_json) as string[],
  desiredState: row.desired_state,
  containerId: row.container_id,
  stateVolume: row.state_volume,
  sshHostPort: row.ssh_host_port,
  sshHostPublicKey: row.ssh_host_public_key,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
  lastError: row.last_error,
});

const applyMigrations = (database: DatabaseSync) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    database
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => Number((row as { version: number }).version)),
  );

  for (const filename of readdirSync(migrationsDirectory).sort()) {
    const match = /^(\d+)-.*\.sql$/.exec(filename);
    if (!match) continue;
    const version = Number(match[1]);
    if (applied.has(version)) continue;

    const sql = readFileSync(join(migrationsDirectory, filename), "utf8");
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(sql);
      database
        .prepare(
          "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
        )
        .run(version, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
};

const columnFor = (key: keyof SandboxRecord) => {
  const columns: Record<keyof SandboxRecord, string> = {
    id: "id",
    name: "name",
    image: "image",
    repositoryUrl: "repository_url",
    command: "initial_command_json",
    desiredState: "desired_state",
    containerId: "container_id",
    stateVolume: "state_volume",
    sshHostPort: "ssh_host_port",
    sshHostPublicKey: "ssh_host_public_key",
    createdAt: "created_at",
    updatedAt: "updated_at",
    deletedAt: "deleted_at",
    lastError: "last_error",
  };
  return columns[key];
};

type SqlValue = string | number | bigint | Uint8Array | null;

const databaseValue = (key: keyof SandboxRecord, value: unknown): SqlValue =>
  key === "command" ? JSON.stringify(value) : (value as SqlValue);

export const openSandboxStore = (filename: string): SandboxStore => {
  if (filename !== ":memory:") {
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  }

  const database = new DatabaseSync(filename);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  applyMigrations(database);

  if (filename !== ":memory:") {
    for (const path of [filename, `${filename}-wal`, `${filename}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  return {
    close: () => database.close(),
    ping: () => {
      database.prepare("SELECT 1").get();
    },
    create: (record) => {
      database
        .prepare(
          `INSERT INTO sandboxes (
            id, name, image, repository_url, initial_command_json,
            desired_state, container_id, state_volume, ssh_host_port,
            ssh_host_public_key, created_at, updated_at, deleted_at, last_error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.name,
          record.image,
          record.repositoryUrl,
          JSON.stringify(record.command),
          record.desiredState,
          record.containerId,
          record.stateVolume,
          record.sshHostPort,
          record.sshHostPublicKey,
          record.createdAt,
          record.updatedAt,
          record.deletedAt,
          record.lastError,
        );
      return record;
    },
    list: (includeDeleted = false) => {
      const where = includeDeleted ? "" : "WHERE deleted_at IS NULL";
      return database
        .prepare(`SELECT * FROM sandboxes ${where} ORDER BY created_at DESC`)
        .all()
        .map((row) => toRecord(row as DatabaseRow));
    },
    get: (idOrName) => {
      const row = database
        .prepare("SELECT * FROM sandboxes WHERE id = ? OR name = ? LIMIT 1")
        .get(idOrName, idOrName);
      return row ? toRecord(row as DatabaseRow) : null;
    },
    update: (id, changes) => {
      const entries = Object.entries(changes) as [
        keyof SandboxRecord,
        unknown,
      ][];
      if (entries.length > 0) {
        const assignments = entries.map(([key]) => `${columnFor(key)} = ?`);
        const values = entries.map(([key, value]) => databaseValue(key, value));
        database
          .prepare(
            `UPDATE sandboxes SET ${assignments.join(", ")} WHERE id = ?`,
          )
          .run(...values, id);
      }
      const row = database
        .prepare("SELECT * FROM sandboxes WHERE id = ?")
        .get(id);
      if (!row) throw new Error(`Sandbox ${id} disappeared during update`);
      return toRecord(row as DatabaseRow);
    },
  };
};

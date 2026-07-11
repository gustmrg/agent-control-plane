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

import type {
  AgentType,
  DesiredState,
  SecretType,
} from "@agent-control/contracts";

export type EncryptedValue = {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
};

export type SecretRecord = {
  name: string;
  type: SecretType;
  backend: "local";
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type StoredSecret = SecretRecord & { encrypted: EncryptedValue };

export type ProfileRecord = {
  name: string;
  agent: AgentType;
  version: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type StoredProfileVersion = ProfileRecord & {
  encryptedBundle: EncryptedValue;
  secretNames: string[];
};

export type SecretLeaseRecord = {
  secretName: string;
  sandboxId: string;
  secretVersion: number;
  acquiredAt: string;
};

export class StoreConflictError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "StoreConflictError";
  }
}

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
  profileName: string | null;
  profileVersion: number | null;
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
  profile_name: string | null;
  profile_version: number | null;
};

type SecretRow = {
  name: string;
  type: SecretType;
  backend: "local";
  version: number;
  created_at: string;
  updated_at: string;
  ciphertext?: Uint8Array;
  nonce?: Uint8Array;
  auth_tag?: Uint8Array;
};

type ProfileRow = {
  name: string;
  agent: AgentType;
  current_version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type ProfileVersionRow = ProfileRow & {
  version: number;
  bundle_ciphertext: Uint8Array;
  bundle_nonce: Uint8Array;
  bundle_auth_tag: Uint8Array;
};

type LeaseRow = {
  secret_name: string;
  sandbox_id: string;
  secret_version: number;
  acquired_at: string;
};

export type SandboxStore = {
  close(): void;
  ping(): void;
  create(record: SandboxRecord): SandboxRecord;
  list(includeDeleted?: boolean): SandboxRecord[];
  get(idOrName: string): SandboxRecord | null;
  update(id: string, changes: Partial<SandboxRecord>): SandboxRecord;
  listSecrets(): SecretRecord[];
  getSecret(name: string): StoredSecret | null;
  putSecret(
    name: string,
    type: SecretType,
    encrypted: EncryptedValue,
    expectedVersion?: number,
  ): SecretRecord;
  deleteSecret(name: string): boolean;
  secretReferenceCount(name: string): number;
  putProfile(
    name: string,
    agent: AgentType,
    encryptedBundle: EncryptedValue,
    secretNames: string[],
  ): ProfileRecord;
  listProfiles(): ProfileRecord[];
  getProfile(name: string): ProfileRecord | null;
  getProfileVersion(name: string, version: number): StoredProfileVersion | null;
  profileSecretNames(name: string, version: number): string[];
  deleteProfile(name: string): boolean;
  setDefaultProfile(agent: AgentType, profileName: string | null): void;
  getDefaultProfile(agent: AgentType): string | null;
  acquireSecretLease(
    secretName: string,
    sandboxId: string,
    secretVersion: number,
  ): SecretLeaseRecord;
  getSecretLease(secretName: string): SecretLeaseRecord | null;
  listSecretLeases(): SecretLeaseRecord[];
  releaseSecretLease(secretName: string, sandboxId: string): boolean;
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
  profileName: row.profile_name,
  profileVersion: row.profile_version,
});

const toSecretRecord = (row: SecretRow): SecretRecord => ({
  name: row.name,
  type: row.type,
  backend: row.backend,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toProfileRecord = (row: ProfileRow): ProfileRecord => ({
  name: row.name,
  agent: row.agent,
  version: row.current_version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at,
});

const toLeaseRecord = (row: LeaseRow): SecretLeaseRecord => ({
  secretName: row.secret_name,
  sandboxId: row.sandbox_id,
  secretVersion: row.secret_version,
  acquiredAt: row.acquired_at,
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
    profileName: "profile_name",
    profileVersion: "profile_version",
  };
  return columns[key];
};

type SqlValue = string | number | bigint | Uint8Array | null;

const databaseValue = (key: keyof SandboxRecord, value: unknown): SqlValue =>
  key === "command" ? JSON.stringify(value) : (value as SqlValue);

const transaction = <T>(database: DatabaseSync, operation: () => T): T => {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
};

export const openSandboxStore = (filename: string): SandboxStore => {
  if (filename !== ":memory:")
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  applyMigrations(database);
  if (filename !== ":memory:") {
    for (const path of [filename, `${filename}-wal`, `${filename}-shm`])
      if (existsSync(path)) chmodSync(path, 0o600);
  }

  const getSecret = (name: string): StoredSecret | null => {
    const row = database
      .prepare(
        `SELECT s.*, v.ciphertext, v.nonce, v.auth_tag
         FROM secrets s
         JOIN local_secret_values v ON v.secret_name = s.name
         WHERE s.name = ?`,
      )
      .get(name) as SecretRow | undefined;
    if (!row?.ciphertext || !row.nonce || !row.auth_tag) return null;
    return {
      ...toSecretRecord(row),
      encrypted: {
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        authTag: row.auth_tag,
      },
    };
  };

  const getProfile = (name: string): ProfileRecord | null => {
    const row = database
      .prepare(
        "SELECT * FROM agent_profiles WHERE name = ? AND deleted_at IS NULL",
      )
      .get(name) as ProfileRow | undefined;
    return row ? toProfileRecord(row) : null;
  };

  const profileSecretNames = (name: string, version: number) =>
    database
      .prepare(
        `SELECT secret_name FROM profile_secret_refs
         WHERE profile_name = ? AND profile_version = ? ORDER BY secret_name`,
      )
      .all(name, version)
      .map((row) => (row as { secret_name: string }).secret_name);

  const getSecretLease = (secretName: string): SecretLeaseRecord | null => {
    const row = database
      .prepare("SELECT * FROM secret_leases WHERE secret_name = ?")
      .get(secretName) as LeaseRow | undefined;
    return row ? toLeaseRecord(row) : null;
  };

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
            ssh_host_public_key, created_at, updated_at, deleted_at, last_error,
            profile_name, profile_version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          record.profileName,
          record.profileVersion,
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
    listSecrets: () =>
      database
        .prepare("SELECT * FROM secrets ORDER BY name")
        .all()
        .map((row) => toSecretRecord(row as SecretRow)),
    getSecret,
    putSecret: (name, type, encrypted, expectedVersion) =>
      transaction(database, () => {
        const existing = getSecret(name);
        if (
          expectedVersion !== undefined &&
          existing?.version !== expectedVersion
        ) {
          throw new StoreConflictError(
            "secret_version_conflict",
            `Secret '${name}' has changed`,
          );
        }
        if (existing && existing.type !== type) {
          throw new StoreConflictError(
            "secret_type_conflict",
            `Secret '${name}' already has type '${existing.type}'`,
          );
        }
        const now = new Date().toISOString();
        const version = (existing?.version ?? 0) + 1;
        if (existing) {
          database
            .prepare(
              "UPDATE secrets SET version = ?, updated_at = ? WHERE name = ?",
            )
            .run(version, now, name);
        } else {
          database
            .prepare(
              `INSERT INTO secrets(name, type, backend, version, created_at, updated_at)
               VALUES (?, ?, 'local', ?, ?, ?)`,
            )
            .run(name, type, version, now, now);
        }
        database
          .prepare(
            `INSERT INTO local_secret_values(secret_name, ciphertext, nonce, auth_tag)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(secret_name) DO UPDATE SET
               ciphertext = excluded.ciphertext,
               nonce = excluded.nonce,
               auth_tag = excluded.auth_tag`,
          )
          .run(name, encrypted.ciphertext, encrypted.nonce, encrypted.authTag);
        return toSecretRecord(
          database
            .prepare("SELECT * FROM secrets WHERE name = ?")
            .get(name) as SecretRow,
        );
      }),
    deleteSecret: (name) =>
      transaction(database, () => {
        const references = Number(
          (
            database
              .prepare(
                "SELECT COUNT(*) AS count FROM profile_secret_refs WHERE secret_name = ?",
              )
              .get(name) as { count: number }
          ).count,
        );
        if (references > 0 || getSecretLease(name)) {
          throw new StoreConflictError(
            "secret_in_use",
            `Secret '${name}' is still in use`,
          );
        }
        return (
          database.prepare("DELETE FROM secrets WHERE name = ?").run(name)
            .changes > 0
        );
      }),
    secretReferenceCount: (name) =>
      Number(
        (
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM profile_secret_refs WHERE secret_name = ?",
            )
            .get(name) as { count: number }
        ).count,
      ),
    putProfile: (name, agent, encryptedBundle, secretNames) =>
      transaction(database, () => {
        const existing = database
          .prepare("SELECT * FROM agent_profiles WHERE name = ?")
          .get(name) as ProfileRow | undefined;
        if (existing && existing.agent !== agent) {
          throw new StoreConflictError(
            "profile_agent_conflict",
            `Profile '${name}' belongs to agent '${existing.agent}'`,
          );
        }
        const now = new Date().toISOString();
        const version = (existing?.current_version ?? 0) + 1;
        if (existing) {
          database
            .prepare(
              `UPDATE agent_profiles
               SET current_version = ?, updated_at = ?, deleted_at = NULL
               WHERE name = ?`,
            )
            .run(version, now, name);
        } else {
          database
            .prepare(
              `INSERT INTO agent_profiles(
                name, agent, current_version, created_at, updated_at, deleted_at
              ) VALUES (?, ?, ?, ?, ?, NULL)`,
            )
            .run(name, agent, version, now, now);
        }
        database
          .prepare(
            `INSERT INTO agent_profile_versions(
              profile_name, version, bundle_ciphertext, bundle_nonce,
              bundle_auth_tag, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            name,
            version,
            encryptedBundle.ciphertext,
            encryptedBundle.nonce,
            encryptedBundle.authTag,
            now,
          );
        const insertReference = database.prepare(
          `INSERT INTO profile_secret_refs(
            profile_name, profile_version, secret_name
          ) VALUES (?, ?, ?)`,
        );
        for (const secretName of [...new Set(secretNames)].sort())
          insertReference.run(name, version, secretName);
        return toProfileRecord(
          database
            .prepare("SELECT * FROM agent_profiles WHERE name = ?")
            .get(name) as ProfileRow,
        );
      }),
    listProfiles: () =>
      database
        .prepare(
          "SELECT * FROM agent_profiles WHERE deleted_at IS NULL ORDER BY name",
        )
        .all()
        .map((row) => toProfileRecord(row as ProfileRow)),
    getProfile,
    getProfileVersion: (name, version) => {
      const row = database
        .prepare(
          `SELECT p.*, v.version, v.bundle_ciphertext, v.bundle_nonce,
                  v.bundle_auth_tag
           FROM agent_profiles p
           JOIN agent_profile_versions v ON v.profile_name = p.name
           WHERE p.name = ? AND v.version = ?`,
        )
        .get(name, version) as ProfileVersionRow | undefined;
      if (!row) return null;
      return {
        ...toProfileRecord(row),
        version: row.version,
        encryptedBundle: {
          ciphertext: row.bundle_ciphertext,
          nonce: row.bundle_nonce,
          authTag: row.bundle_auth_tag,
        },
        secretNames: profileSecretNames(name, version),
      };
    },
    profileSecretNames,
    deleteProfile: (name) =>
      transaction(database, () => {
        database
          .prepare("DELETE FROM agent_profile_defaults WHERE profile_name = ?")
          .run(name);
        return (
          database
            .prepare(
              "UPDATE agent_profiles SET deleted_at = ?, updated_at = ? WHERE name = ? AND deleted_at IS NULL",
            )
            .run(new Date().toISOString(), new Date().toISOString(), name)
            .changes > 0
        );
      }),
    setDefaultProfile: (agent, profileName) => {
      if (profileName === null) {
        database
          .prepare("DELETE FROM agent_profile_defaults WHERE agent = ?")
          .run(agent);
        return;
      }
      const profile = getProfile(profileName);
      if (!profile || profile.agent !== agent) {
        throw new StoreConflictError(
          "profile_agent_conflict",
          `Profile '${profileName}' is not an active '${agent}' profile`,
        );
      }
      database
        .prepare(
          `INSERT INTO agent_profile_defaults(agent, profile_name) VALUES (?, ?)
           ON CONFLICT(agent) DO UPDATE SET profile_name = excluded.profile_name`,
        )
        .run(agent, profileName);
    },
    getDefaultProfile: (agent) => {
      const row = database
        .prepare(
          "SELECT profile_name FROM agent_profile_defaults WHERE agent = ?",
        )
        .get(agent) as { profile_name: string } | undefined;
      return row?.profile_name ?? null;
    },
    acquireSecretLease: (secretName, sandboxId, secretVersion) =>
      transaction(database, () => {
        const existing = getSecretLease(secretName);
        if (existing) {
          if (existing.sandboxId === sandboxId) return existing;
          throw new StoreConflictError(
            "secret_in_use",
            `Secret '${secretName}' is already leased`,
            { sandboxId: existing.sandboxId },
          );
        }
        const acquiredAt = new Date().toISOString();
        database
          .prepare(
            "INSERT INTO secret_leases(secret_name, sandbox_id, secret_version, acquired_at) VALUES (?, ?, ?, ?)",
          )
          .run(secretName, sandboxId, secretVersion, acquiredAt);
        return { secretName, sandboxId, secretVersion, acquiredAt };
      }),
    getSecretLease,
    listSecretLeases: () =>
      database
        .prepare("SELECT * FROM secret_leases ORDER BY acquired_at")
        .all()
        .map((row) => toLeaseRecord(row as LeaseRow)),
    releaseSecretLease: (secretName, sandboxId) =>
      database
        .prepare(
          "DELETE FROM secret_leases WHERE secret_name = ? AND sandbox_id = ?",
        )
        .run(secretName, sandboxId).changes > 0,
  };
};

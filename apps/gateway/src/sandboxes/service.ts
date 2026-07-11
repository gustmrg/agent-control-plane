import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import type {
  CreateSandboxRequest,
  ObservedState,
  Sandbox,
  SandboxConnection,
} from "@agent-control/contracts";

import type { ContainerRuntime, RuntimeSandbox } from "../docker/runtime.js";
import { AppError, notFound } from "../errors.js";
import type { SandboxRecord, SandboxStore } from "../persistence/store.js";
import type { ProfileService } from "../profiles/service.js";

export type SandboxServiceOptions = {
  store: SandboxStore;
  runtime: ContainerRuntime;
  defaultImage?: string;
  profiles?: ProfileService;
};

const observedState = (
  record: SandboxRecord,
  runtime: RuntimeSandbox | null,
): ObservedState => {
  if (record.deletedAt || record.desiredState === "deleted") return "deleted";
  if (!runtime) return record.containerId ? "missing" : "creating";
  return runtime.state;
};

const toSandbox = (
  record: SandboxRecord,
  runtime: RuntimeSandbox | null,
): Sandbox => ({
  id: record.id,
  name: record.name,
  image: record.image,
  repositoryUrl: record.repositoryUrl,
  command: record.command,
  desiredState: record.desiredState,
  observedState: observedState(record, runtime),
  containerId: runtime?.containerId ?? record.containerId,
  stateVolume: record.stateVolume,
  sshHostPort: runtime?.sshHostPort ?? record.sshHostPort,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  deletedAt: record.deletedAt,
  lastError: record.lastError,
  profileName: record.profileName,
  profileVersion: record.profileVersion,
});

export class SandboxService {
  private readonly store: SandboxStore;
  private readonly runtime: ContainerRuntime;
  private readonly defaultImage: string;
  private readonly profiles: ProfileService | undefined;

  constructor(options: SandboxServiceOptions) {
    this.store = options.store;
    this.runtime = options.runtime;
    this.defaultImage = options.defaultImage ?? "agent-control-sandbox:latest";
    this.profiles = options.profiles;
  }

  private record(idOrName: string) {
    const record = this.store.get(idOrName);
    if (!record || record.deletedAt) throw notFound("Sandbox");
    return record;
  }

  private async syncCredentials(record: SandboxRecord) {
    if (!this.profiles) return;
    const leased = this.store
      .listSecretLeases()
      .some((lease) => lease.sandboxId === record.id);
    if (!leased) return;
    const path = this.profiles.authPath(record);
    if (!path) return;
    const auth = await this.runtime.readStateFile(record.id, path);
    if (!auth)
      throw new AppError(
        502,
        "secret_writeback_failed",
        "Agent authentication file is missing; the credential lease was retained",
      );
    this.profiles.writeBack(record, auth);
  }

  async create(input: CreateSandboxRequest): Promise<Sandbox> {
    if (input.profileName && !this.profiles) {
      throw new AppError(
        503,
        "secrets_not_configured",
        "Secret management is not configured on this gateway",
      );
    }
    const profile =
      this.profiles?.resolve(input.profileName, input.command) ?? null;
    const name = input.name ?? `sandbox-${Date.now().toString(36)}`;
    const existing = this.store.get(name);
    if (existing && !existing.deletedAt) {
      throw new AppError(
        409,
        "sandbox_name_conflict",
        `Sandbox name '${name}' is already in use`,
      );
    }
    const id = existing?.id ?? randomUUID();
    const now = new Date().toISOString();
    const record = existing
      ? this.store.update(existing.id, {
          image: input.image ?? this.defaultImage,
          repositoryUrl: input.repositoryUrl ?? null,
          command: input.command,
          desiredState: "running",
          containerId: null,
          sshHostPort: null,
          sshHostPublicKey: null,
          updatedAt: now,
          deletedAt: null,
          lastError: null,
          profileName: profile?.name ?? null,
          profileVersion: profile?.version ?? null,
        })
      : this.store.create({
          id,
          name,
          image: input.image ?? this.defaultImage,
          repositoryUrl: input.repositoryUrl ?? null,
          command: input.command,
          desiredState: "running",
          containerId: null,
          stateVolume: `agent-control-state-${id}`,
          sshHostPort: null,
          sshHostPublicKey: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          lastError: null,
          profileName: profile?.name ?? null,
          profileVersion: profile?.version ?? null,
        });

    try {
      const bootstrapFiles = this.profiles?.bootstrap(record) ?? [];
      const runtime = await this.runtime.create({
        id,
        name,
        image: record.image,
        ...(input.repositoryUrl ? { repositoryUrl: input.repositoryUrl } : {}),
        publicKey: input.publicKey,
        command: input.command,
        stateVolume: record.stateVolume,
        ...(input.cpu ? { cpu: input.cpu } : {}),
        ...(input.memory ? { memory: input.memory } : {}),
        ...(bootstrapFiles.length ? { bootstrapFiles } : {}),
      });
      const updated = this.store.update(id, {
        containerId: runtime.containerId,
        sshHostPort: runtime.sshHostPort,
        sshHostPublicKey: runtime.sshHostPublicKey,
        updatedAt: new Date().toISOString(),
      });
      return toSandbox(updated, runtime);
    } catch (error) {
      this.profiles?.release(record);
      const failedAt = new Date().toISOString();
      this.store.update(id, {
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: failedAt,
        ...(error instanceof AppError && error.statusCode === 409
          ? { desiredState: "deleted", deletedAt: failedAt }
          : {}),
      });
      if (error instanceof AppError) throw error;
      throw new AppError(502, "runtime_error", "Failed to create sandbox");
    }
  }

  async list() {
    return Promise.all(
      this.store
        .list()
        .map(async (record) =>
          toSandbox(record, await this.runtime.inspect(record.id)),
        ),
    );
  }

  async get(idOrName: string) {
    const record = this.record(idOrName);
    return toSandbox(record, await this.runtime.inspect(record.id));
  }

  async start(idOrName: string) {
    const record = this.record(idOrName);
    this.profiles?.acquire(record);
    try {
      await this.runtime.start(record.id);
    } catch (error) {
      this.profiles?.release(record);
      throw error;
    }
    const updated = this.store.update(record.id, {
      desiredState: "running",
      updatedAt: new Date().toISOString(),
      lastError: null,
    });
    return toSandbox(updated, await this.runtime.inspect(record.id));
  }

  async stop(idOrName: string) {
    const record = this.record(idOrName);
    await this.runtime.stop(record.id);
    const updated = this.store.update(record.id, {
      desiredState: "stopped",
      updatedAt: new Date().toISOString(),
    });
    try {
      await this.syncCredentials(updated);
    } catch (error) {
      this.store.update(record.id, {
        lastError: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      });
      if (error instanceof AppError) throw error;
      throw new AppError(
        502,
        "secret_writeback_failed",
        "Failed to persist agent authentication; the credential lease was retained",
      );
    }
    return toSandbox(updated, await this.runtime.inspect(record.id));
  }

  async delete(idOrName: string, deleteVolume: boolean) {
    const record = this.record(idOrName);
    await this.runtime.stop(record.id);
    await this.syncCredentials(record);
    await this.runtime.remove(record.id);
    if (deleteVolume) await this.runtime.removeVolume(record.stateVolume);
    const now = new Date().toISOString();
    const updated = this.store.update(record.id, {
      desiredState: "deleted",
      containerId: null,
      deletedAt: now,
      updatedAt: now,
    });
    return toSandbox(updated, null);
  }

  async connection(idOrName: string): Promise<SandboxConnection> {
    const record = this.record(idOrName);
    const runtime = await this.runtime.inspect(record.id);
    if (
      runtime?.state !== "running" ||
      !runtime.sshHostPort ||
      !record.sshHostPublicKey
    ) {
      throw new AppError(409, "sandbox_not_ready", "Sandbox SSH is not ready");
    }
    return {
      sandboxId: record.id,
      sandboxName: record.name,
      user: "sandbox",
      host: "127.0.0.1",
      port: runtime.sshHostPort,
      hostPublicKey: record.sshHostPublicKey,
    };
  }

  async logs(
    idOrName: string,
    options: { tail?: boolean; lines?: number },
  ): Promise<Readable> {
    const record = this.record(idOrName);
    return this.runtime.logs(record.id, options);
  }

  async reconcile() {
    const runtimes = new Map(
      (await this.runtime.listManaged()).map((runtime) => [
        runtime.sandboxId,
        runtime,
      ]),
    );
    for (const record of this.store.list()) {
      const runtime = runtimes.get(record.id);
      if (!runtime && record.containerId) {
        this.store.update(record.id, {
          lastError: "Managed container is missing",
          updatedAt: new Date().toISOString(),
        });
        continue;
      }
      if (runtime) {
        if (runtime.state === "stopped") {
          try {
            await this.syncCredentials(record);
          } catch (error) {
            this.store.update(record.id, {
              lastError: error instanceof Error ? error.message : String(error),
              updatedAt: new Date().toISOString(),
            });
          }
        }
        this.store.update(record.id, {
          containerId: runtime.containerId,
          sshHostPort: runtime.sshHostPort,
          updatedAt: new Date().toISOString(),
        });
        runtimes.delete(record.id);
      }
    }
    return [...runtimes.values()];
  }
}

import type { Readable } from "node:stream";

export type RuntimeState = "running" | "stopped" | "failed";

export type RuntimeSandbox = {
  sandboxId: string;
  containerId: string;
  stateVolume: string;
  state: RuntimeState;
  sshHostPort: number | null;
  sshHostPublicKey: string | null;
};

export type CreateRuntimeSandbox = {
  id: string;
  name: string;
  image: string;
  repositoryUrl?: string;
  publicKey: string;
  command: string[];
  stateVolume: string;
  cpu?: string;
  memory?: string;
  bootstrapFiles?: StateFile[];
};

export type StateFile = {
  path: string;
  content: Buffer;
  mode: 0o600 | 0o644 | 0o700 | 0o755;
  jsonMergeKeys?: string[];
};

export type ContainerRuntime = {
  ping(): Promise<void>;
  create(spec: CreateRuntimeSandbox): Promise<RuntimeSandbox>;
  inspect(id: string): Promise<RuntimeSandbox | null>;
  listManaged(): Promise<RuntimeSandbox[]>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  removeVolume(name: string): Promise<void>;
  readStateFile(id: string, path: string): Promise<Buffer | null>;
  logs(
    id: string,
    options?: { tail?: boolean; lines?: number },
  ): Promise<Readable>;
};

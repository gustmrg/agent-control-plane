import type { SecretType } from "@agent-control/contracts";

import type { SandboxStore, SecretRecord } from "../persistence/store.js";
import type { SecretBackend } from "./backend.js";
import type { SecretCipher } from "./crypto.js";

const metadata = (record: SecretRecord) => ({
  name: record.name,
  type: record.type,
  backend: record.backend,
  version: record.version,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const context = (name: string, type: SecretType) =>
  `agent-control:secret:${name}:${type}`;

export class LocalSecretBackend implements SecretBackend {
  constructor(
    private readonly store: SandboxStore,
    private readonly cipher: SecretCipher,
  ) {}

  list() {
    return this.store.listSecrets().map(metadata);
  }

  get(name: string) {
    const stored = this.store.getSecret(name);
    if (!stored) return null;
    return {
      metadata: metadata(stored),
      value: this.cipher.decrypt(
        stored.encrypted,
        context(stored.name, stored.type),
      ),
    };
  }

  put(
    name: string,
    type: SecretType,
    value: Uint8Array,
    expectedVersion?: number,
  ) {
    const encrypted = this.cipher.encrypt(value, context(name, type));
    return metadata(
      this.store.putSecret(name, type, encrypted, expectedVersion),
    );
  }

  delete(name: string) {
    return this.store.deleteSecret(name);
  }
}

import type { SecretMetadata, SecretType } from "@agent-control/contracts";

export type ResolvedSecret = {
  metadata: SecretMetadata;
  value: Buffer;
};

export type SecretBackend = {
  list(): SecretMetadata[];
  get(name: string): ResolvedSecret | null;
  put(
    name: string,
    type: SecretType,
    value: Uint8Array,
    expectedVersion?: number,
  ): SecretMetadata;
  delete(name: string): boolean;
};

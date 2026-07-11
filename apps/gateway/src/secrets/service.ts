import type {
  PutSecretRequest,
  SecretMetadata,
} from "@agent-control/contracts";

import { AppError, notFound } from "../errors.js";
import { StoreConflictError } from "../persistence/store.js";
import type { SecretBackend } from "./backend.js";

const MAX_SECRET_BYTES = 1024 * 1024;

export const decodeBase64 = (value: string, label: string) => {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new AppError(400, "invalid_request", `${label} is not valid base64`);
  return Buffer.from(value, "base64");
};

const storeError = (error: unknown): never => {
  if (error instanceof StoreConflictError)
    throw new AppError(409, error.code, error.message, error.details);
  throw error;
};

export class SecretService {
  constructor(private readonly backend?: SecretBackend) {}

  private configured() {
    if (!this.backend)
      throw new AppError(
        503,
        "secrets_not_configured",
        "Secret management is not configured on this gateway",
      );
    return this.backend;
  }

  list(): SecretMetadata[] {
    return this.configured().list();
  }

  get(name: string): SecretMetadata {
    const secret = this.configured().get(name);
    if (!secret) throw notFound("Secret");
    return secret.metadata;
  }

  resolve(name: string) {
    const secret = this.configured().get(name);
    if (!secret) throw notFound("Secret");
    return secret;
  }

  put(name: string, input: PutSecretRequest): SecretMetadata {
    const value = decodeBase64(input.valueBase64, "Secret value");
    if (value.byteLength > MAX_SECRET_BYTES)
      throw new AppError(
        413,
        "secret_too_large",
        "Secret values may not exceed 1 MiB",
      );
    try {
      return this.configured().put(
        name,
        input.type,
        value,
        input.expectedVersion,
      );
    } catch (error) {
      return storeError(error);
    }
  }

  delete(name: string): SecretMetadata {
    const existing = this.get(name);
    try {
      if (!this.configured().delete(name)) throw notFound("Secret");
      return existing;
    } catch (error) {
      return storeError(error);
    }
  }
}

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import type { EncryptedValue } from "../persistence/store.js";

export type SecretCipher = {
  encrypt(value: Uint8Array, context: string): EncryptedValue;
  decrypt(value: EncryptedValue, context: string): Buffer;
};

export const createSecretCipher = (key: Uint8Array): SecretCipher => {
  if (key.byteLength !== 32)
    throw new Error("The secret master key must contain exactly 32 bytes");
  const normalizedKey = Buffer.from(key);
  return {
    encrypt: (value, context) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", normalizedKey, nonce);
      cipher.setAAD(Buffer.from(context));
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(value)),
        cipher.final(),
      ]);
      return { ciphertext, nonce, authTag: cipher.getAuthTag() };
    },
    decrypt: (value, context) => {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        normalizedKey,
        value.nonce,
      );
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(Buffer.from(value.authTag));
      return Buffer.concat([
        decipher.update(Buffer.from(value.ciphertext)),
        decipher.final(),
      ]);
    },
  };
};

export const loadSecretCipher = (filename: string) =>
  createSecretCipher(readFileSync(filename));

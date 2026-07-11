import { posix } from "node:path";

import {
  profileBundleSchema,
  type AgentProfile,
  type AgentType,
  type ProfileBundle,
  type PutAgentProfileRequest,
  type SecretType,
} from "@agent-control/contracts";

import { AppError, notFound } from "../errors.js";
import {
  StoreConflictError,
  type ProfileRecord,
  type SandboxStore,
} from "../persistence/store.js";
import type { SandboxRecord } from "../persistence/store.js";
import type { StateFile } from "../docker/runtime.js";
import type { SecretCipher } from "../secrets/crypto.js";
import { decodeBase64, SecretService } from "../secrets/service.js";

const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;

const allowedCredentialTypes: Record<AgentType, SecretType[]> = {
  codex: ["codex-auth"],
  opencode: ["opencode-openai-oauth", "opencode-go-key"],
};

const allowedPath = (agent: AgentType, path: string) => {
  if (path.startsWith(".agents/skills/")) return true;
  if (agent === "codex") return path === ".codex/config.toml";
  return path.startsWith(".config/opencode/");
};

const validateBundle = (encoded: string, agent: AgentType) => {
  const decoded = decodeBase64(encoded, "Profile bundle");
  if (decoded.byteLength > MAX_BUNDLE_BYTES)
    throw new AppError(
      413,
      "profile_too_large",
      "Profile bundles may not exceed 50 MiB",
    );
  let source: unknown;
  try {
    source = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new AppError(
      400,
      "invalid_profile_bundle",
      "Profile bundle must contain valid JSON",
    );
  }
  const bundle = profileBundleSchema.parse(source);
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of bundle.files) {
    const normalized = posix.normalize(file.path);
    if (
      file.path.includes("\\") ||
      posix.isAbsolute(file.path) ||
      normalized !== file.path ||
      normalized === ".." ||
      normalized.startsWith("../") ||
      !allowedPath(agent, normalized)
    ) {
      throw new AppError(
        400,
        "invalid_profile_path",
        `Profile path '${file.path}' is not allowed for ${agent}`,
      );
    }
    if (paths.has(normalized))
      throw new AppError(
        400,
        "duplicate_profile_path",
        `Profile path '${file.path}' appears more than once`,
      );
    paths.add(normalized);
    totalBytes += decodeBase64(
      file.contentBase64,
      `Profile file '${file.path}'`,
    ).byteLength;
    if (totalBytes > MAX_BUNDLE_BYTES)
      throw new AppError(
        413,
        "profile_too_large",
        "Profile files may not exceed 50 MiB in total",
      );
  }
  return Buffer.from(JSON.stringify(bundle));
};

const profileContext = (name: string) => `agent-control:profile:${name}`;
const mutableTypes = new Set<SecretType>([
  "codex-auth",
  "opencode-openai-oauth",
]);

const jsonObject = (value: Buffer, label: string) => {
  try {
    const parsed = JSON.parse(value.toString("utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // Report one stable, non-sensitive error below.
  }
  throw new AppError(
    400,
    "invalid_auth_secret",
    `${label} must contain a JSON object`,
  );
};

export const mergeOpenCodeAuth = (
  existing: Buffer | null,
  managed: { type: SecretType; value: Buffer }[],
) => {
  const auth = existing ? jsonObject(existing, "OpenCode auth") : {};
  for (const credential of managed) {
    if (credential.type === "opencode-openai-oauth")
      auth.openai = jsonObject(credential.value, "OpenAI OAuth secret");
    if (credential.type === "opencode-go-key")
      auth["opencode-go"] = jsonObject(credential.value, "OpenCode Go secret");
  }
  return Buffer.from(JSON.stringify(auth));
};

export class ProfileService {
  constructor(
    private readonly store: SandboxStore,
    private readonly secrets: SecretService,
    private readonly cipher?: SecretCipher,
  ) {}

  private configured() {
    if (!this.cipher)
      throw new AppError(
        503,
        "secrets_not_configured",
        "Secret management is not configured on this gateway",
      );
    return this.cipher;
  }

  private metadata(record: ProfileRecord): AgentProfile {
    const credentials = this.store
      .profileSecretNames(record.name, record.version)
      .map((secretName) => {
        const secret = this.secrets.get(secretName);
        return { secretName, type: secret.type };
      });
    return {
      name: record.name,
      agent: record.agent,
      version: record.version,
      credentials,
      isDefault: this.store.getDefaultProfile(record.agent) === record.name,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  list() {
    this.configured();
    return this.store.listProfiles().map((profile) => this.metadata(profile));
  }

  get(name: string) {
    this.configured();
    const profile = this.store.getProfile(name);
    if (!profile) throw notFound("Profile");
    return this.metadata(profile);
  }

  put(name: string, input: PutAgentProfileRequest) {
    const cipher = this.configured();
    const bundle = validateBundle(input.bundleBase64, input.agent);
    const seenTypes = new Set<SecretType>();
    for (const secretName of input.secretNames) {
      const secret = this.secrets.get(secretName);
      if (!allowedCredentialTypes[input.agent].includes(secret.type)) {
        throw new AppError(
          400,
          "incompatible_profile_secret",
          `Secret '${secretName}' is not compatible with ${input.agent}`,
        );
      }
      if (seenTypes.has(secret.type)) {
        throw new AppError(
          400,
          "duplicate_profile_secret_type",
          `A ${input.agent} profile may reference only one '${secret.type}' secret`,
        );
      }
      seenTypes.add(secret.type);
    }
    try {
      return this.metadata(
        this.store.putProfile(
          name,
          input.agent,
          cipher.encrypt(bundle, profileContext(name)),
          input.secretNames,
        ),
      );
    } catch (error) {
      if (error instanceof StoreConflictError)
        throw new AppError(409, error.code, error.message, error.details);
      throw error;
    }
  }

  delete(name: string) {
    const profile = this.get(name);
    if (!this.store.deleteProfile(name)) throw notFound("Profile");
    return profile;
  }

  setDefault(agent: AgentType, profileName: string | null) {
    this.configured();
    try {
      this.store.setDefaultProfile(agent, profileName);
    } catch (error) {
      if (error instanceof StoreConflictError)
        throw new AppError(409, error.code, error.message, error.details);
      throw error;
    }
    return profileName ? this.get(profileName) : { agent, profileName: null };
  }

  resolve(profileName: string | undefined, command: string[]) {
    this.configured();
    const detected = this.detectAgent(command);
    const resolvedName =
      profileName ?? (detected ? this.store.getDefaultProfile(detected) : null);
    if (!resolvedName) return null;
    const profile = this.store.getProfile(resolvedName);
    if (!profile) throw notFound("Profile");
    if (detected && profile.agent !== detected) {
      throw new AppError(
        400,
        "profile_agent_mismatch",
        `Profile '${resolvedName}' cannot configure agent '${detected}'`,
      );
    }
    return this.metadata(profile);
  }

  version(name: string, version: number) {
    const cipher = this.configured();
    const stored = this.store.getProfileVersion(name, version);
    if (!stored) throw notFound("Profile version");
    return {
      profile: stored,
      bundle: cipher.decrypt(stored.encryptedBundle, profileContext(name)),
    };
  }

  acquire(record: SandboxRecord) {
    if (!record.profileName || !record.profileVersion) return [];
    const version = this.version(record.profileName, record.profileVersion);
    const acquired: string[] = [];
    try {
      for (const secretName of version.profile.secretNames) {
        const secret = this.secrets.resolve(secretName);
        if (!mutableTypes.has(secret.metadata.type)) continue;
        this.store.acquireSecretLease(
          secretName,
          record.id,
          secret.metadata.version,
        );
        acquired.push(secretName);
      }
      return acquired;
    } catch (error) {
      for (const secretName of acquired)
        this.store.releaseSecretLease(secretName, record.id);
      if (error instanceof StoreConflictError) {
        const ownerId = (error.details as { sandboxId?: string } | undefined)
          ?.sandboxId;
        const owner = ownerId ? this.store.get(ownerId) : null;
        throw new AppError(
          409,
          error.code,
          owner
            ? `Credential is already in use by sandbox '${owner.name}'`
            : error.message,
        );
      }
      throw error;
    }
  }

  bootstrap(record: SandboxRecord, existingOpenCodeAuth: Buffer | null = null) {
    if (!record.profileName || !record.profileVersion) return [];
    const stored = this.version(record.profileName, record.profileVersion);
    const bundle = profileBundleSchema.parse(
      JSON.parse(stored.bundle.toString("utf8")),
    ) as ProfileBundle;
    this.acquire(record);
    const files: StateFile[] = bundle.files.map((file) => ({
      path: file.path,
      content: decodeBase64(file.contentBase64, `Profile file '${file.path}'`),
      mode: file.mode,
    }));
    const credentials = stored.profile.secretNames.map((secretName) => {
      const secret = this.secrets.resolve(secretName);
      return { type: secret.metadata.type, value: secret.value };
    });
    if (stored.profile.agent === "codex") {
      const auth = credentials.find(({ type }) => type === "codex-auth");
      if (auth)
        files.push({
          path: ".codex/auth.json",
          content: auth.value,
          mode: 0o600,
        });
    } else if (credentials.length) {
      files.push({
        path: ".local/share/opencode/auth.json",
        content: mergeOpenCodeAuth(existingOpenCodeAuth, credentials),
        mode: 0o600,
        jsonMergeKeys: ["openai", "opencode-go"],
      });
    }
    return files;
  }

  writeBack(record: SandboxRecord, authFile: Buffer) {
    if (!record.profileName || !record.profileVersion) return;
    const stored = this.version(record.profileName, record.profileVersion);
    const auth =
      stored.profile.agent === "opencode"
        ? jsonObject(authFile, "OpenCode auth")
        : null;
    for (const secretName of stored.profile.secretNames) {
      const secret = this.secrets.resolve(secretName);
      if (!mutableTypes.has(secret.metadata.type)) continue;
      const lease = this.store.getSecretLease(secretName);
      if (!lease || lease.sandboxId !== record.id)
        throw new AppError(
          409,
          "secret_lease_missing",
          "Credential lease is missing",
        );
      const value =
        secret.metadata.type === "codex-auth"
          ? authFile
          : Buffer.from(JSON.stringify(auth?.openai));
      if (secret.metadata.type === "opencode-openai-oauth" && !auth?.openai)
        throw new AppError(
          400,
          "invalid_auth_writeback",
          "OpenCode auth no longer contains the managed OpenAI OAuth entry",
        );
      this.secrets.put(secretName, {
        type: secret.metadata.type,
        valueBase64: value.toString("base64"),
        expectedVersion: lease.secretVersion,
      });
    }
    this.release(record);
  }

  release(record: SandboxRecord) {
    for (const lease of this.store.listSecretLeases())
      if (lease.sandboxId === record.id)
        this.store.releaseSecretLease(lease.secretName, record.id);
  }

  authPath(record: SandboxRecord) {
    if (!record.profileName || !record.profileVersion) return null;
    return this.version(record.profileName, record.profileVersion).profile
      .agent === "codex"
      ? ".codex/auth.json"
      : ".local/share/opencode/auth.json";
  }

  private detectAgent(command: string[]): AgentType | null {
    const executable = command[0]?.split("/").at(-1);
    return executable === "codex" || executable === "opencode"
      ? executable
      : null;
  }
}

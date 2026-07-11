import { z } from "zod";

export const resourceNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/, {
    message:
      "Sandbox names must start with a letter and contain only lowercase letters, numbers, and hyphens",
  });

const sandboxName = resourceNameSchema;

const httpsRepositoryUrl = z
  .url()
  .refine((value) => new URL(value).protocol === "https:", {
    message: "Repository URL must use HTTPS",
  });

const sshPublicKey = z
  .string()
  .max(16_384)
  .regex(/^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+(?: .*)?$/);

export const desiredStateSchema = z.enum(["running", "stopped", "deleted"]);
export type DesiredState = z.infer<typeof desiredStateSchema>;

export const observedStateSchema = z.enum([
  "creating",
  "starting",
  "running",
  "stopped",
  "failed",
  "missing",
  "deleted",
]);
export type ObservedState = z.infer<typeof observedStateSchema>;

export const createSandboxRequestSchema = z.object({
  name: sandboxName.optional(),
  image: z.string().trim().min(1).max(512).optional(),
  repositoryUrl: httpsRepositoryUrl.optional(),
  publicKey: sshPublicKey,
  command: z.array(z.string().max(4096)).max(128).default([]),
  cpu: z
    .string()
    .regex(/^\d+(?:\.\d+)?$/)
    .optional(),
  memory: z
    .string()
    .regex(/^\d+(?:\.\d+)?(?:[KMGT]i?|[kmgt])?[Bb]?$/)
    .optional(),
  profileName: sandboxName.optional(),
});
export type CreateSandboxRequest = z.infer<typeof createSandboxRequestSchema>;

export const sandboxSchema = z.object({
  id: z.uuid(),
  name: sandboxName,
  image: z.string(),
  repositoryUrl: httpsRepositoryUrl.nullable(),
  command: z.array(z.string()),
  desiredState: desiredStateSchema,
  observedState: observedStateSchema,
  containerId: z.string().nullable(),
  stateVolume: z.string(),
  sshHostPort: z.number().int().min(1).max(65_535).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  profileName: sandboxName.nullable().default(null),
  profileVersion: z.number().int().positive().nullable().default(null),
});
export type Sandbox = z.infer<typeof sandboxSchema>;

export const sandboxListResponseSchema = z.object({
  data: z.array(sandboxSchema),
});

export const sandboxResponseSchema = z.object({ data: sandboxSchema });

export const sandboxConnectionSchema = z.object({
  sandboxId: z.uuid(),
  sandboxName,
  user: z.string().min(1),
  host: z.literal("127.0.0.1"),
  port: z.number().int().min(1).max(65_535),
  hostPublicKey: sshPublicKey,
});
export type SandboxConnection = z.infer<typeof sandboxConnectionSchema>;

export const sandboxConnectionResponseSchema = z.object({
  data: sandboxConnectionSchema,
});

const queryBoolean = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => value === true || value === "true");

export const deleteSandboxQuerySchema = z.object({
  deleteVolume: queryBoolean.default(false),
});

export const logsQuerySchema = z.object({
  tail: queryBoolean.default(false),
  lines: z.coerce.number().int().min(1).max(10_000).default(200),
});

export const directHostConfigSchema = z.object({
  transport: z.literal("direct"),
  apiEndpoint: z.url(),
  token: z.string().min(1),
});

export const sshHostConfigSchema = z.object({
  transport: z.literal("ssh"),
  sshTarget: z.string().trim().min(1),
  apiAddress: z
    .string()
    .regex(/^(?:127\.0\.0\.1|localhost):\d{1,5}$/)
    .default("127.0.0.1:7070"),
  token: z.string().min(1),
});

export const hostConfigSchema = z.discriminatedUnion("transport", [
  directHostConfigSchema,
  sshHostConfigSchema,
]);
export type HostConfig = z.infer<typeof hostConfigSchema>;

export const clientConfigSchema = z.object({
  activeHost: z.string().optional(),
  hosts: z.record(z.string(), hostConfigSchema).default({}),
});
export type ClientConfig = z.infer<typeof clientConfigSchema>;

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const statusResponseSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
  docker: z.literal("ok"),
  database: z.literal("ok"),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;

export const secretTypeSchema = z.enum([
  "codex-auth",
  "opencode-openai-oauth",
  "opencode-go-key",
  "opaque",
]);
export type SecretType = z.infer<typeof secretTypeSchema>;

export const secretMetadataSchema = z.object({
  name: sandboxName,
  type: secretTypeSchema,
  backend: z.literal("local"),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type SecretMetadata = z.infer<typeof secretMetadataSchema>;

export const putSecretRequestSchema = z.object({
  type: secretTypeSchema,
  valueBase64: z.string().min(1).max(1_500_000),
  expectedVersion: z.number().int().positive().optional(),
});
export type PutSecretRequest = z.infer<typeof putSecretRequestSchema>;

export const agentTypeSchema = z.enum(["codex", "opencode"]);
export type AgentType = z.infer<typeof agentTypeSchema>;

export const profileCredentialSchema = z.object({
  secretName: sandboxName,
  type: secretTypeSchema,
});
export type ProfileCredential = z.infer<typeof profileCredentialSchema>;

export const agentProfileSchema = z.object({
  name: sandboxName,
  agent: agentTypeSchema,
  version: z.number().int().positive(),
  credentials: z.array(profileCredentialSchema),
  isDefault: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;

export const putAgentProfileRequestSchema = z.object({
  agent: agentTypeSchema,
  bundleBase64: z.string().min(1).max(70_000_000),
  secretNames: z.array(sandboxName).max(8).default([]),
});
export type PutAgentProfileRequest = z.infer<
  typeof putAgentProfileRequestSchema
>;

export const profileBundleFileSchema = z.object({
  path: z.string().min(1).max(4096),
  contentBase64: z.string().max(15_000_000),
  mode: z.union([
    z.literal(0o600),
    z.literal(0o644),
    z.literal(0o700),
    z.literal(0o755),
  ]),
});

export const profileBundleSchema = z.object({
  version: z.literal(1),
  files: z.array(profileBundleFileSchema).max(5000),
});
export type ProfileBundle = z.infer<typeof profileBundleSchema>;

export const setDefaultProfileRequestSchema = z.object({
  profileName: sandboxName,
});

export const secretResponseSchema = z.object({ data: secretMetadataSchema });
export const secretListResponseSchema = z.object({
  data: z.array(secretMetadataSchema),
});
export const agentProfileResponseSchema = z.object({
  data: agentProfileSchema,
});
export const agentProfileListResponseSchema = z.object({
  data: z.array(agentProfileSchema),
});

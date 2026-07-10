import { z } from "zod";

const sandboxName = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/, {
    message:
      "Sandbox names must start with a letter and contain only lowercase letters, numbers, and hyphens",
  });

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

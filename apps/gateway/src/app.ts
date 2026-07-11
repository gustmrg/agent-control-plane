import {
  agentTypeSchema,
  createSandboxRequestSchema,
  deleteSandboxQuerySchema,
  logsQuerySchema,
  putAgentProfileRequestSchema,
  putSecretRequestSchema,
  resourceNameSchema,
  setDefaultProfileRequestSchema,
} from "@agent-control/contracts";
import Fastify from "fastify";
import { ZodError } from "zod";

import type { ContainerRuntime } from "./docker/runtime.js";
import { AppError } from "./errors.js";
import type { SandboxStore } from "./persistence/store.js";
import { ProfileService } from "./profiles/service.js";
import { SandboxService } from "./sandboxes/service.js";
import type { SecretBackend } from "./secrets/backend.js";
import type { SecretCipher } from "./secrets/crypto.js";
import { SecretService } from "./secrets/service.js";

export type BuildAppOptions = {
  store: SandboxStore;
  runtime: ContainerRuntime;
  token: string;
  defaultImage?: string;
  logger?: boolean;
  secretBackend?: SecretBackend;
  secretCipher?: SecretCipher;
  trustProxy?: boolean;
};

export const buildApp = (options: BuildAppOptions) => {
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: options.trustProxy ?? false,
  });
  const secrets = new SecretService(options.secretBackend);
  const profiles = new ProfileService(
    options.store,
    secrets,
    options.secretCipher,
  );
  const service = new SandboxService({
    store: options.store,
    runtime: options.runtime,
    ...(options.defaultImage ? { defaultImage: options.defaultImage } : {}),
    ...(options.secretCipher ? { profiles } : {}),
  });

  app.get("/healthz", async () => ({ status: "ok", version: "0.1.0" }));
  app.get("/readyz", async () => {
    options.store.ping();
    await options.runtime.ping();
    return { status: "ok", version: "0.1.0", docker: "ok", database: "ok" };
  });

  app.addHook("onRequest", async (request) => {
    if (request.url === "/healthz" || request.url === "/readyz") return;
    if (request.headers.authorization !== `Bearer ${options.token}`) {
      throw new AppError(401, "unauthorized", "Unauthorized");
    }
    if (
      (request.url.startsWith("/v1/secrets") ||
        request.url.startsWith("/v1/profiles")) &&
      !["127.0.0.1", "localhost", "::1", "[::1]"].includes(request.hostname) &&
      request.protocol !== "https"
    ) {
      throw new AppError(
        400,
        "insecure_secret_transport",
        "Secret and profile operations require HTTPS, an SSH tunnel, or loopback",
      );
    }
  });

  app.get("/v1/sandboxes", async () => ({ data: await service.list() }));

  app.get("/v1/secrets", async () => ({ data: secrets.list() }));
  app.get<{ Params: { name: string } }>(
    "/v1/secrets/:name",
    async (request) => ({
      data: secrets.get(resourceNameSchema.parse(request.params.name)),
    }),
  );
  app.put<{ Params: { name: string } }>(
    "/v1/secrets/:name",
    { bodyLimit: 1_500_000 },
    async (request) => ({
      data: secrets.put(
        resourceNameSchema.parse(request.params.name),
        putSecretRequestSchema.parse(request.body),
      ),
    }),
  );
  app.delete<{ Params: { name: string } }>(
    "/v1/secrets/:name",
    async (request) => ({
      data: secrets.delete(resourceNameSchema.parse(request.params.name)),
    }),
  );

  app.get("/v1/profiles", async () => ({ data: profiles.list() }));
  app.get<{ Params: { name: string } }>(
    "/v1/profiles/:name",
    async (request) => ({
      data: profiles.get(resourceNameSchema.parse(request.params.name)),
    }),
  );
  app.put<{ Params: { name: string } }>(
    "/v1/profiles/:name",
    { bodyLimit: 70_000_000 },
    async (request) => ({
      data: profiles.put(
        resourceNameSchema.parse(request.params.name),
        putAgentProfileRequestSchema.parse(request.body),
      ),
    }),
  );
  app.delete<{ Params: { name: string } }>(
    "/v1/profiles/:name",
    async (request) => ({
      data: profiles.delete(resourceNameSchema.parse(request.params.name)),
    }),
  );
  app.put<{ Params: { agent: string } }>(
    "/v1/profiles/defaults/:agent",
    async (request) => {
      const agent = agentTypeSchema.parse(request.params.agent);
      const input = setDefaultProfileRequestSchema.parse(request.body);
      return { data: profiles.setDefault(agent, input.profileName) };
    },
  );
  app.delete<{ Params: { agent: string } }>(
    "/v1/profiles/defaults/:agent",
    async (request) => ({
      data: profiles.setDefault(
        agentTypeSchema.parse(request.params.agent),
        null,
      ),
    }),
  );
  app.post("/v1/sandboxes", async (request, reply) => {
    const input = createSandboxRequestSchema.parse(request.body);
    const sandbox = await service.create(input);
    return reply.code(201).send({ data: sandbox });
  });
  app.get<{ Params: { id: string } }>("/v1/sandboxes/:id", async (request) => ({
    data: await service.get(request.params.id),
  }));
  app.post<{ Params: { id: string } }>(
    "/v1/sandboxes/:id/start",
    async (request) => ({ data: await service.start(request.params.id) }),
  );
  app.post<{ Params: { id: string } }>(
    "/v1/sandboxes/:id/stop",
    async (request) => ({ data: await service.stop(request.params.id) }),
  );
  app.delete<{ Params: { id: string } }>(
    "/v1/sandboxes/:id",
    async (request) => {
      const query = deleteSandboxQuerySchema.parse(request.query);
      return {
        data: await service.delete(request.params.id, query.deleteVolume),
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/sandboxes/:id/connection",
    async (request) => ({ data: await service.connection(request.params.id) }),
  );
  app.get<{ Params: { id: string } }>(
    "/v1/sandboxes/:id/logs",
    async (request, reply) => {
      const query = logsQuerySchema.parse(request.query);
      reply.header("content-type", "text/plain; charset=utf-8");
      return reply.send(await service.logs(request.params.id, query));
    },
  );

  app.setNotFoundHandler(async () => {
    throw new AppError(404, "route_not_found", "Route not found");
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: "Request validation failed",
          details: error.issues,
        },
      });
    }
    app.log.error(error);
    return reply.code(500).send({
      error: { code: "internal_error", message: "Internal server error" },
    });
  });

  return app;
};

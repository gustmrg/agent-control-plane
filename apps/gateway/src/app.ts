import {
  createSandboxRequestSchema,
  deleteSandboxQuerySchema,
  logsQuerySchema,
} from "@agent-control/contracts";
import Fastify from "fastify";
import { ZodError } from "zod";

import type { ContainerRuntime } from "./docker/runtime.js";
import { AppError } from "./errors.js";
import type { SandboxStore } from "./persistence/store.js";
import { SandboxService } from "./sandboxes/service.js";

export type BuildAppOptions = {
  store: SandboxStore;
  runtime: ContainerRuntime;
  token: string;
  defaultImage?: string;
  logger?: boolean;
};

export const buildApp = (options: BuildAppOptions) => {
  const app = Fastify({ logger: options.logger ?? false });
  const service = new SandboxService({
    store: options.store,
    runtime: options.runtime,
    ...(options.defaultImage ? { defaultImage: options.defaultImage } : {}),
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
  });

  app.get("/v1/sandboxes", async () => ({ data: await service.list() }));
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

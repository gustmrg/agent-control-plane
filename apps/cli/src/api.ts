import type {
  CreateSandboxRequest,
  Sandbox,
  SandboxConnection,
  StatusResponse,
} from "@agent-control/contracts";

import type { HostConfig } from "@agent-control/contracts";

import { withGatewayEndpoint } from "./tunnel.js";

type ApiEnvelope<T> = { data: T };

export class GatewayClient {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
  ) {}

  private async response(path: string, init: RequestInit = {}) {
    const response = await fetch(`${this.endpoint}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(
        body?.error?.message ?? `Gateway request failed (${response.status})`,
      );
    }
    return response;
  }

  async status() {
    return (await (await this.response("/readyz")).json()) as StatusResponse;
  }

  async list() {
    return (
      (await (await this.response("/v1/sandboxes")).json()) as ApiEnvelope<
        Sandbox[]
      >
    ).data;
  }

  async get(id: string) {
    return (
      (await (
        await this.response(`/v1/sandboxes/${encodeURIComponent(id)}`)
      ).json()) as ApiEnvelope<Sandbox>
    ).data;
  }

  async create(input: CreateSandboxRequest) {
    return (
      (await (
        await this.response("/v1/sandboxes", {
          method: "POST",
          body: JSON.stringify(input),
        })
      ).json()) as ApiEnvelope<Sandbox>
    ).data;
  }

  async action(id: string, action: "start" | "stop") {
    return (
      (await (
        await this.response(
          `/v1/sandboxes/${encodeURIComponent(id)}/${action}`,
          {
            method: "POST",
          },
        )
      ).json()) as ApiEnvelope<Sandbox>
    ).data;
  }

  async delete(id: string, deleteVolume: boolean) {
    return (
      (await (
        await this.response(
          `/v1/sandboxes/${encodeURIComponent(id)}?deleteVolume=${String(deleteVolume)}`,
          { method: "DELETE" },
        )
      ).json()) as ApiEnvelope<Sandbox>
    ).data;
  }

  async connection(id: string) {
    return (
      (await (
        await this.response(
          `/v1/sandboxes/${encodeURIComponent(id)}/connection`,
        )
      ).json()) as ApiEnvelope<SandboxConnection>
    ).data;
  }

  async logs(id: string, tail: boolean, lines: number) {
    return this.response(
      `/v1/sandboxes/${encodeURIComponent(id)}/logs?tail=${String(tail)}&lines=${lines}`,
    );
  }
}

export const withGatewayClient = <T>(
  host: HostConfig,
  operation: (client: GatewayClient) => Promise<T>,
) =>
  withGatewayEndpoint(host, (endpoint) =>
    operation(new GatewayClient(endpoint, host.token)),
  );

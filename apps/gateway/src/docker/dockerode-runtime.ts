import { PassThrough, Readable } from "node:stream";

import Docker from "dockerode";

import type {
  ContainerRuntime,
  CreateRuntimeSandbox,
  RuntimeSandbox,
} from "./runtime.js";

const labels = (id: string, name: string, resource: "container" | "state") => ({
  "agent-control.managed": "true",
  "agent-control.sandbox-id": id,
  "agent-control.sandbox-name": name,
  "agent-control.resource": resource,
});

const memoryBytes = (value?: string) => {
  if (!value) return 2 * 1024 ** 3;
  const match = /^(\d+(?:\.\d+)?)([KMGT]?i?[Bb]?)?$/i.exec(value);
  if (!match) throw new Error(`Invalid memory value: ${value}`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase().replace(/b$/, "");
  const powers: Record<string, number> = {
    "": 1,
    k: 1000,
    ki: 1024,
    m: 1000 ** 2,
    mi: 1024 ** 2,
    g: 1000 ** 3,
    gi: 1024 ** 3,
    t: 1000 ** 4,
    ti: 1024 ** 4,
  };
  return Math.floor(amount * (powers[unit] ?? 1));
};

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const demuxBuffer = (buffer: Buffer) => {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset + 4);
    const end = offset + 8 + length;
    if (end > buffer.length) return buffer;
    chunks.push(buffer.subarray(offset + 8, end));
    offset = end;
  }
  return offset === buffer.length && chunks.length > 0
    ? Buffer.concat(chunks)
    : buffer;
};

export class DockerodeRuntime implements ContainerRuntime {
  private readonly docker: Docker;

  constructor(
    socketPath = "/var/run/docker.sock",
    private readonly networkName = "agent-control",
  ) {
    this.docker = new Docker({ socketPath });
  }

  async ping() {
    await this.docker.ping();
  }

  private async ensureNetwork() {
    try {
      await this.docker.getNetwork(this.networkName).inspect();
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status !== 404) throw error;
      await this.docker.createNetwork({
        Name: this.networkName,
        CheckDuplicate: true,
        Labels: { "agent-control.managed": "true" },
      });
    }
  }

  private async pullImage(image: string) {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    }

    const stream = await this.docker.pull(image);
    await new Promise<void>((resolve, reject) => {
      this.docker.modem.followProgress(stream, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private async readHostKey(container: Docker.Container) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const exec = await container.exec({
          Cmd: ["cat", "/etc/ssh/ssh_host_ed25519_key.pub"],
          AttachStdout: true,
          AttachStderr: true,
        });
        const stream = await exec.start({});
        const chunks: Buffer[] = [];
        for await (const chunk of stream as Readable)
          chunks.push(Buffer.from(chunk));
        const output = Buffer.concat(chunks).toString("utf8");
        const line =
          /ssh-(?:ed25519|rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/=]+(?: [^\r\n]+)?/.exec(
            output,
          )?.[0];
        if (line) return line.trim();
      } catch {
        // The SSH daemon may still be initializing.
      }
      await sleep(500);
    }
    throw new Error("Sandbox SSH host key was not ready within 15 seconds");
  }

  async create(spec: CreateRuntimeSandbox): Promise<RuntimeSandbox> {
    await this.ensureNetwork();
    await this.pullImage(spec.image);
    await this.docker.createVolume({
      Name: spec.stateVolume,
      Labels: labels(spec.id, spec.name, "state"),
    });

    const container = await this.docker.createContainer({
      name: `agent-control-${spec.name}-${spec.id.slice(0, 8)}`,
      Image: spec.image,
      Labels: {
        ...labels(spec.id, spec.name, "container"),
        "agent-control.state-volume": spec.stateVolume,
      },
      Env: [
        `SANDBOX_PUBLIC_KEY=${spec.publicKey}`,
        `SANDBOX_COMMAND_JSON=${JSON.stringify(spec.command)}`,
        ...(spec.repositoryUrl
          ? [`SANDBOX_REPO_URL=${spec.repositoryUrl}`]
          : []),
      ],
      ExposedPorts: { "22/tcp": {} },
      HostConfig: {
        Binds: [`${spec.stateVolume}:/home/sandbox`],
        PortBindings: {
          "22/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }],
        },
        NetworkMode: this.networkName,
        AutoRemove: false,
        RestartPolicy: { Name: "no" },
        CapDrop: ["ALL"],
        CapAdd: [
          "CHOWN",
          "DAC_OVERRIDE",
          "AUDIT_WRITE",
          "FOWNER",
          "NET_BIND_SERVICE",
          "SETGID",
          "SETUID",
          "SYS_CHROOT",
        ],
        SecurityOpt: ["no-new-privileges:true"],
        PidsLimit: 512,
        Memory: memoryBytes(spec.memory),
        NanoCpus: Math.floor(Number(spec.cpu ?? "2") * 1_000_000_000),
      },
    });

    try {
      await container.start();
      const hostKey = await this.readHostKey(container);
      const runtime = await this.inspect(spec.id);
      if (!runtime) throw new Error("Created sandbox was not discoverable");
      return { ...runtime, sshHostPublicKey: hostKey };
    } catch (error) {
      await container.remove({ force: true }).catch(() => undefined);
      throw error;
    }
  }

  private fromInspect(
    sandboxId: string,
    inspect: Docker.ContainerInspectInfo,
  ): RuntimeSandbox {
    const binding = inspect.NetworkSettings.Ports?.["22/tcp"]?.[0];
    return {
      sandboxId,
      containerId: inspect.Id,
      stateVolume:
        inspect.Config.Labels?.["agent-control.state-volume"] ??
        `agent-control-state-${sandboxId}`,
      state: inspect.State.Running
        ? "running"
        : inspect.State.Status === "exited" ||
            inspect.State.Status === "created"
          ? "stopped"
          : "failed",
      sshHostPort: binding ? Number(binding.HostPort) : null,
      sshHostPublicKey: null,
    };
  }

  async inspect(id: string): Promise<RuntimeSandbox | null> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({
        label: [
          "agent-control.managed=true",
          `agent-control.sandbox-id=${id}`,
          "agent-control.resource=container",
        ],
      }),
    });
    const summary = containers[0];
    if (!summary) return null;
    const inspect = await this.docker.getContainer(summary.Id).inspect();
    return this.fromInspect(id, inspect);
  }

  async listManaged(): Promise<RuntimeSandbox[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: ["agent-control.managed=true"] }),
    });
    return Promise.all(
      containers.map(async (summary) => {
        const id = summary.Labels["agent-control.sandbox-id"];
        if (!id)
          throw new Error(
            `Managed container ${summary.Id} has no sandbox ID label`,
          );
        const inspect = await this.docker.getContainer(summary.Id).inspect();
        return this.fromInspect(id, inspect);
      }),
    );
  }

  private async containerFor(id: string) {
    const runtime = await this.inspect(id);
    return runtime ? this.docker.getContainer(runtime.containerId) : null;
  }

  async start(id: string) {
    const runtime = await this.inspect(id);
    if (!runtime) throw new Error("Sandbox container not found");
    if (runtime.state === "running") return;
    const container = this.docker.getContainer(runtime.containerId);
    await container.start();
  }

  async stop(id: string) {
    const runtime = await this.inspect(id);
    if (!runtime) throw new Error("Sandbox container not found");
    if (runtime.state === "stopped") return;
    const container = this.docker.getContainer(runtime.containerId);
    await container.stop({ t: 10 });
  }

  async remove(id: string) {
    const container = await this.containerFor(id);
    if (container) await container.remove({ force: true });
  }

  async removeVolume(name: string) {
    await this.docker
      .getVolume(name)
      .remove()
      .catch((error: unknown) => {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      });
  }

  async logs(id: string, options: { tail?: boolean; lines?: number } = {}) {
    const container = await this.containerFor(id);
    if (!container) throw new Error("Sandbox container not found");

    if (options.tail) {
      const stream = await container.logs({
        stdout: true,
        stderr: true,
        follow: true,
        tail: options.lines ?? 200,
        timestamps: true,
      });
      const output = new PassThrough();
      this.docker.modem.demuxStream(stream, output, output);
      stream.once("error", (error: Error) => output.destroy(error));
      return output;
    }

    const buffer = await container.logs({
      stdout: true,
      stderr: true,
      follow: false,
      tail: options.lines ?? 200,
      timestamps: true,
    });
    return Readable.from([demuxBuffer(buffer)]);
  }
}

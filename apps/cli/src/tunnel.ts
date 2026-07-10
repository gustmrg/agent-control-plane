import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";

import type { HostConfig } from "@agent-control/contracts";

const getFreePort = async () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

const waitForPort = async (port: number, timeoutMilliseconds = 10_000) => {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("SSH tunnel did not become ready within 10 seconds");
};

export const withGatewayEndpoint = async <T>(
  host: HostConfig,
  operation: (endpoint: string) => Promise<T>,
): Promise<T> => {
  if (host.transport === "direct") return operation(host.apiEndpoint);

  const localPort = await getFreePort();
  const child = spawn(
    "ssh",
    [
      "-o",
      "ExitOnForwardFailure=yes",
      "-N",
      "-L",
      `127.0.0.1:${localPort}:${host.apiAddress}`,
      host.sshTarget,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  try {
    await Promise.race([
      waitForPort(localPort),
      new Promise<never>((_, reject) => {
        child.once("exit", (code) =>
          reject(
            new Error(
              `SSH tunnel exited before becoming ready (${code ?? "signal"})`,
            ),
          ),
        );
        child.once("error", reject);
      }),
    ]);
    return await operation(`http://127.0.0.1:${localPort}`);
  } finally {
    if (!exited) child.kill("SIGTERM");
  }
};

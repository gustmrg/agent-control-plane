import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";

import type { HostConfig, SandboxConnection } from "@agent-control/contracts";

import {
  configDirectory,
  identityFile as defaultIdentityFile,
  keysDirectory,
  knownHostsFile as defaultKnownHostsFile,
} from "./paths.js";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const workspaceDirectory =
  "cd /home/sandbox/workspace/repo 2>/dev/null || cd /home/sandbox/workspace";

export const workspaceCommand = (command: string[]) => [
  "sh",
  "-lc",
  `${workspaceDirectory}; exec ${command.map(shellQuote).join(" ")}`,
];

export const connectCommand = (shellOnly = false) => {
  if (shellOnly) return workspaceCommand(["bash", "-l"]);
  return [
    "sh",
    "-lc",
    `${workspaceDirectory}; if tmux has-session -t agent 2>/dev/null; then exec tmux attach-session -t agent; else exec bash -l; fi`,
  ];
};

export const ensureIdentity = () => {
  mkdirSync(keysDirectory(), { recursive: true, mode: 0o700 });
  const identity = defaultIdentityFile();
  if (!existsSync(identity) || !existsSync(`${identity}.pub`)) {
    const result = spawnSync(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", "agentctl", "-f", identity],
      { stdio: "inherit" },
    );
    if (result.status !== 0)
      throw new Error("Failed to generate sandbox SSH key");
  }
  chmodSync(identity, 0o600);
  chmodSync(`${identity}.pub`, 0o644);
  return {
    privateKey: identity,
    publicKey: readFileSync(`${identity}.pub`, "utf8").trim(),
  };
};

const hostKeyAlias = (hostName: string, sandboxId: string) =>
  `agent-control-${hostName}-${sandboxId}`;

export const trustHostKey = (
  hostName: string,
  connection: SandboxConnection,
  filename = defaultKnownHostsFile(),
) => {
  mkdirSync(configDirectory(), { recursive: true, mode: 0o700 });
  const alias = hostKeyAlias(hostName, connection.sandboxId);
  const existing = existsSync(filename)
    ? readFileSync(filename, "utf8").split("\n")
    : [];
  const retained = existing.filter(
    (line) => line && !line.startsWith(`${alias} `),
  );
  retained.push(`${alias} ${connection.hostPublicKey}`);
  writeFileSync(filename, `${retained.join("\n")}\n`, { mode: 0o600 });
  chmodSync(filename, 0o600);
};

export type BuildSshArgsOptions = {
  hostName: string;
  host: HostConfig;
  connection: SandboxConnection;
  identityFile: string;
  knownHostsFile: string;
  command?: string[];
  tty?: boolean;
};

export const buildSandboxSshArgs = (options: BuildSshArgsOptions) => {
  const args: string[] = [];
  if (options.host.transport === "ssh") args.push("-J", options.host.sshTarget);
  if (options.tty) args.push("-tt");
  args.push(
    "-p",
    String(options.connection.port),
    "-i",
    options.identityFile,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    `UserKnownHostsFile=${options.knownHostsFile}`,
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `HostKeyAlias=${hostKeyAlias(options.hostName, options.connection.sandboxId)}`,
    `${options.connection.user}@${options.connection.host}`,
  );
  if (options.command?.length)
    args.push(options.command.map(shellQuote).join(" "));
  return args;
};

export const runSandboxSsh = async (options: BuildSshArgsOptions) => {
  const child = spawn("ssh", buildSandboxSshArgs(options), {
    stdio: "inherit",
  });
  const status = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`SSH terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  return status;
};

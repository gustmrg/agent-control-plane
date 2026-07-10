import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

import {
  clientConfigSchema,
  type ClientConfig,
  type HostConfig,
} from "@agent-control/contracts";

import { configDirectory, configFile } from "./paths.js";

export type ResolvedHost = { name: string; config: HostConfig };

const unquote = (value: string) => JSON.parse(value) as string;

const parseConfig = (source: string): ClientConfig => {
  const raw: {
    activeHost?: string;
    hosts: Record<string, Record<string, string>>;
  } = {
    hosts: {},
  };
  let currentHost: string | undefined;
  for (const originalLine of source.split("\n")) {
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) continue;
    const section = /^\[hosts\.(.+)]$/.exec(line);
    if (section) {
      currentHost = section[1]!.startsWith('"')
        ? unquote(section[1]!)
        : section[1]!;
      raw.hosts[currentHost] = {};
      continue;
    }
    const pair = /^([a-zA-Z_]+)\s*=\s*("(?:[^"\\]|\\.)*")$/.exec(line);
    if (!pair) throw new Error(`Unsupported config line: ${originalLine}`);
    const key = pair[1]!;
    const value = unquote(pair[2]!);
    if (!currentHost && key === "active_host") raw.activeHost = value;
    else if (currentHost) raw.hosts[currentHost]![key] = value;
  }
  return clientConfigSchema.parse({
    ...(raw.activeHost ? { activeHost: raw.activeHost } : {}),
    hosts: Object.fromEntries(
      Object.entries(raw.hosts).map(([name, value]) => [
        name,
        value.transport === "ssh"
          ? {
              transport: "ssh",
              sshTarget: value.ssh_target,
              apiAddress: value.api_address,
              token: value.token,
            }
          : {
              transport: "direct",
              apiEndpoint: value.api_endpoint,
              token: value.token,
            },
      ]),
    ),
  });
};

const stringifyConfig = (config: ClientConfig) => {
  const lines: string[] = [];
  if (config.activeHost)
    lines.push(`active_host = ${JSON.stringify(config.activeHost)}`, "");
  for (const [name, host] of Object.entries(config.hosts)) {
    lines.push(`[hosts.${JSON.stringify(name)}]`);
    lines.push(`transport = ${JSON.stringify(host.transport)}`);
    if (host.transport === "ssh") {
      lines.push(`ssh_target = ${JSON.stringify(host.sshTarget)}`);
      lines.push(`api_address = ${JSON.stringify(host.apiAddress)}`);
    } else {
      lines.push(`api_endpoint = ${JSON.stringify(host.apiEndpoint)}`);
    }
    lines.push(`token = ${JSON.stringify(host.token)}`, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
};

export const loadConfig = (): ClientConfig => {
  if (!existsSync(configFile())) return { hosts: {} };
  return parseConfig(readFileSync(configFile(), "utf8"));
};

export const saveConfig = (config: ClientConfig) => {
  mkdirSync(configDirectory(), { recursive: true, mode: 0o700 });
  const temporary = `${configFile()}.tmp`;
  writeFileSync(temporary, stringifyConfig(config), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, configFile());
  chmodSync(configFile(), 0o600);
};

export const resolveHost = (
  config: ClientConfig,
  flag?: string,
  environment = process.env.AGENTCTL_HOST,
): ResolvedHost => {
  const name =
    flag ??
    environment ??
    config.activeHost ??
    (config.hosts.local ? "local" : undefined);
  if (!name) {
    throw new Error(
      "No active host. Register one with: agentctl host add <name> --endpoint <url>",
    );
  }
  const host = config.hosts[name];
  if (!host) throw new Error(`Unknown host '${name}'`);
  return { name, config: host };
};

export const putHost = (
  config: ClientConfig,
  name: string,
  host: HostConfig,
): ClientConfig => ({
  activeHost: name,
  hosts: { ...config.hosts, [name]: host },
});

export const selectHost = (
  config: ClientConfig,
  name: string,
): ClientConfig => {
  if (!config.hosts[name]) throw new Error(`Unknown host '${name}'`);
  return { ...config, activeHost: name };
};

export const removeHost = (
  config: ClientConfig,
  name: string,
): ClientConfig => {
  if (!config.hosts[name]) throw new Error(`Unknown host '${name}'`);
  const hosts = { ...config.hosts };
  delete hosts[name];
  const activeHost = config.activeHost === name ? undefined : config.activeHost;
  return activeHost ? { hosts, activeHost } : { hosts };
};

#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

import {
  createSandboxRequestSchema,
  directHostConfigSchema,
  sshHostConfigSchema,
} from "@agent-control/contracts";

import { withGatewayClient } from "./api.js";
import {
  loadConfig,
  putHost,
  removeHost,
  resolveHost,
  saveConfig,
  selectHost,
} from "./config.js";
import { printSandbox, printSandboxes, type OutputFormat } from "./output.js";
import { knownHostsFile } from "./paths.js";
import {
  ensureIdentity,
  runSandboxSsh,
  trustHostKey,
  workspaceCommand,
} from "./ssh.js";

type GlobalOptions = { host?: string; output: OutputFormat; quiet: boolean };
type CommandOptions = {
  values: Record<string, string>;
  flags: Set<string>;
  positionals: string[];
  trailing: string[];
};

const usage = `agentctl - create and manage agent sandboxes

Usage:
  agentctl [--host NAME] [--output table|json] <command>

Commands:
  status
  doctor
  host add|list|select|info|remove
  sandbox create|list|get|connect|exec|start|stop|delete
  logs
  completions bash|zsh
  version
`;

const parseGlobals = (argv: string[]) => {
  const separator = argv.indexOf("--");
  const before = separator < 0 ? argv : argv.slice(0, separator);
  const trailing = separator < 0 ? [] : argv.slice(separator + 1);
  const options: GlobalOptions = { output: "table", quiet: false };
  const args: string[] = [];
  for (let index = 0; index < before.length; index += 1) {
    const value = before[index]!;
    if (value === "-H" || value === "--host") {
      const host = before[++index];
      if (!host) throw new Error(`Missing value for ${value}`);
      options.host = host;
    } else if (value === "-o" || value === "--output") {
      const output = before[++index];
      if (output !== "table" && output !== "json")
        throw new Error("Output must be table or json");
      options.output = output;
    } else if (value === "--quiet") options.quiet = true;
    else if (value === "--no-color") continue;
    else args.push(value);
  }
  return { options, args, trailing };
};

const parseOptions = (
  args: string[],
  trailing: string[],
  definitions: Record<string, { key: string; boolean?: boolean }>,
): CommandOptions => {
  const result: CommandOptions = {
    values: {},
    flags: new Set(),
    positionals: [],
    trailing,
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("-")) {
      result.positionals.push(value);
      continue;
    }
    const definition = definitions[value];
    if (!definition) throw new Error(`Unknown option: ${value}`);
    if (definition.boolean) result.flags.add(definition.key);
    else {
      const optionValue = args[++index];
      if (!optionValue) throw new Error(`Missing value for ${value}`);
      result.values[definition.key] = optionValue;
    }
  }
  return result;
};

const requirePosition = (values: string[], index: number, label: string) => {
  const value = values[index];
  if (!value) throw new Error(`Missing ${label}`);
  return value;
};

const tokenFromInput = async (requested: boolean) => {
  if (!requested) {
    const token = process.env.AGENTCTL_API_TOKEN;
    if (!token) throw new Error("Use --token-stdin or set AGENTCTL_API_TOKEN");
    return token;
  }
  let value = "";
  for await (const chunk of process.stdin) value += chunk.toString();
  const token = value.trim();
  if (!token) throw new Error("No token was provided on stdin");
  return token;
};

const main = async () => {
  const parsed = parseGlobals(process.argv.slice(2));
  const [group, action, ...rest] = parsed.args;
  if (!group || group === "help" || group === "--help" || group === "-h") {
    console.log(usage);
    return;
  }

  const selectedHost = () => {
    const config = loadConfig();
    return resolveHost(config, parsed.options.host);
  };

  if (group === "version" || group === "--version" || group === "-V") {
    console.log("0.1.0");
    return;
  }

  if (group === "host") {
    if (action === "add") {
      const options = parseOptions(rest, parsed.trailing, {
        "--ssh": { key: "ssh" },
        "--endpoint": { key: "endpoint" },
        "--api-address": { key: "apiAddress" },
        "--token-stdin": { key: "tokenStdin", boolean: true },
      });
      const name = requirePosition(options.positionals, 0, "host name");
      if (Boolean(options.values.ssh) === Boolean(options.values.endpoint)) {
        throw new Error("Provide exactly one of --ssh or --endpoint");
      }
      const token = await tokenFromInput(options.flags.has("tokenStdin"));
      const host = options.values.ssh
        ? sshHostConfigSchema.parse({
            transport: "ssh",
            sshTarget: options.values.ssh,
            apiAddress: options.values.apiAddress ?? "127.0.0.1:7070",
            token,
          })
        : directHostConfigSchema.parse({
            transport: "direct",
            apiEndpoint: options.values.endpoint,
            token,
          });
      saveConfig(putHost(loadConfig(), name, host));
      console.log(`Host '${name}' added and selected`);
      return;
    }
    if (action === "list") {
      const config = loadConfig();
      const rows = Object.entries(config.hosts).map(([name, value]) => ({
        name,
        active: config.activeHost === name,
        transport: value.transport,
        target: value.transport === "ssh" ? value.sshTarget : value.apiEndpoint,
      }));
      if (parsed.options.output === "json")
        console.log(JSON.stringify(rows, null, 2));
      else
        for (const row of rows)
          console.log(
            `${row.active ? "*" : " "} ${row.name}\t${row.transport}\t${row.target}`,
          );
      return;
    }
    if (action === "select") {
      const name = requirePosition(rest, 0, "host name");
      saveConfig(selectHost(loadConfig(), name));
      console.log(`Host '${name}' selected`);
      return;
    }
    if (action === "info") {
      const config = loadConfig();
      const selected = resolveHost(config, rest[0]);
      console.log(
        JSON.stringify(
          { name: selected.name, ...selected.config, token: "<redacted>" },
          null,
          2,
        ),
      );
      return;
    }
    if (action === "remove") {
      const name = requirePosition(rest, 0, "host name");
      saveConfig(removeHost(loadConfig(), name));
      console.log(`Host '${name}' removed`);
      return;
    }
    throw new Error("Usage: agentctl host add|list|select|info|remove");
  }

  if (group === "status") {
    const selected = selectedHost();
    const status = await withGatewayClient(selected.config, (client) =>
      client.status(),
    );
    if (parsed.options.output === "json")
      console.log(JSON.stringify({ host: selected.name, ...status }, null, 2));
    else
      console.log(
        `${selected.name}: gateway ${status.status}, docker ${status.docker}, database ${status.database}`,
      );
    return;
  }

  const sandboxGroup = group === "sandbox" || group === "sb";
  if (sandboxGroup && action === "create") {
    const options = parseOptions(rest, parsed.trailing, {
      "--name": { key: "name" },
      "--image": { key: "image" },
      "--repo": { key: "repo" },
      "--cpu": { key: "cpu" },
      "--memory": { key: "memory" },
    });
    if (options.positionals.length)
      throw new Error("Put the sandbox command after --");
    const selected = selectedHost();
    const key = ensureIdentity();
    const request = createSandboxRequestSchema.parse({
      ...(options.values.name ? { name: options.values.name } : {}),
      ...(options.values.image ? { image: options.values.image } : {}),
      ...(options.values.repo ? { repositoryUrl: options.values.repo } : {}),
      ...(options.values.cpu ? { cpu: options.values.cpu } : {}),
      ...(options.values.memory ? { memory: options.values.memory } : {}),
      publicKey: key.publicKey,
      command: options.trailing,
    });
    printSandbox(
      await withGatewayClient(selected.config, (client) =>
        client.create(request),
      ),
      parsed.options.output,
    );
    return;
  }

  if (sandboxGroup && action === "list") {
    const selected = selectedHost();
    printSandboxes(
      await withGatewayClient(selected.config, (client) => client.list()),
      parsed.options.output,
    );
    return;
  }

  if (sandboxGroup && action === "get") {
    const id = requirePosition(rest, 0, "sandbox name or ID");
    const selected = selectedHost();
    printSandbox(
      await withGatewayClient(selected.config, (client) => client.get(id)),
      parsed.options.output,
    );
    return;
  }

  if (sandboxGroup && (action === "start" || action === "stop")) {
    const id = requirePosition(rest, 0, "sandbox name or ID");
    const selected = selectedHost();
    printSandbox(
      await withGatewayClient(selected.config, (client) =>
        client.action(id, action),
      ),
      parsed.options.output,
    );
    return;
  }

  if (sandboxGroup && action === "delete") {
    const options = parseOptions(rest, parsed.trailing, {
      "--delete-volume": { key: "deleteVolume", boolean: true },
      "--force": { key: "force", boolean: true },
    });
    const id = requirePosition(options.positionals, 0, "sandbox name or ID");
    if (options.flags.has("deleteVolume") && !options.flags.has("force")) {
      if (!process.stdin.isTTY)
        throw new Error("Use --force with --delete-volume in automation");
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await prompt.question(
        "Permanently delete the state volume? Type 'delete': ",
      );
      prompt.close();
      if (answer !== "delete") throw new Error("Deletion cancelled");
    }
    const selected = selectedHost();
    printSandbox(
      await withGatewayClient(selected.config, (client) =>
        client.delete(id, options.flags.has("deleteVolume")),
      ),
      parsed.options.output,
    );
    return;
  }

  if (sandboxGroup && (action === "connect" || action === "exec")) {
    const id = requirePosition(rest, 0, "sandbox name or ID");
    if (action === "exec" && parsed.trailing.length === 0)
      throw new Error("Put the command after --");
    const selected = selectedHost();
    const connection = await withGatewayClient(selected.config, (client) =>
      client.connection(id),
    );
    const key = ensureIdentity();
    trustHostKey(selected.name, connection);
    process.exitCode = await runSandboxSsh({
      hostName: selected.name,
      host: selected.config,
      connection,
      identityFile: key.privateKey,
      knownHostsFile: knownHostsFile(),
      command:
        action === "exec"
          ? workspaceCommand(parsed.trailing)
          : workspaceCommand(["bash", "-l"]),
      tty: action === "connect",
    });
    return;
  }

  if (group === "logs") {
    const options = parseOptions(
      [action, ...rest].filter(Boolean) as string[],
      parsed.trailing,
      {
        "--tail": { key: "tail", boolean: true },
        "--lines": { key: "lines" },
      },
    );
    const id = requirePosition(options.positionals, 0, "sandbox name or ID");
    const selected = selectedHost();
    const response = await withGatewayClient(selected.config, (client) =>
      client.logs(
        id,
        options.flags.has("tail"),
        Number(options.values.lines ?? 200),
      ),
    );
    if (!response.body) return;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      process.stdout.write(value);
    }
    return;
  }

  if (group === "doctor") {
    const ssh = spawnSync("ssh", ["-V"], { encoding: "utf8" });
    if (ssh.status !== 0) throw new Error("OpenSSH client is unavailable");
    const selected = selectedHost();
    await withGatewayClient(selected.config, (client) => client.status());
    console.log(`ok: OpenSSH and gateway '${selected.name}' are ready`);
    return;
  }

  if (group === "completions") {
    const shell = action;
    if (shell === "zsh") console.log("compdef _gnu_generic agentctl");
    else if (shell === "bash")
      console.log("complete -o default -F _longopt agentctl");
    else throw new Error("Supported shells: bash, zsh");
    return;
  }

  throw new Error(`Unknown command\n\n${usage}`);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

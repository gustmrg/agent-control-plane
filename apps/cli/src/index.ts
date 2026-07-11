#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import {
  agentTypeSchema,
  createSandboxRequestSchema,
  directHostConfigSchema,
  putAgentProfileRequestSchema,
  putSecretRequestSchema,
  secretTypeSchema,
  sshHostConfigSchema,
} from "@agent-control/contracts";

import { GatewayError, withGatewayClient } from "./api.js";
import {
  loadConfig,
  putHost,
  removeHost,
  resolveHost,
  saveConfig,
  selectHost,
} from "./config.js";
import {
  createOutputContext,
  printError,
  printHosts,
  printProfile,
  printProfiles,
  printProperties,
  printSandbox,
  printSandboxes,
  printSecret,
  printSecrets,
  printStatus,
  printSuccess,
  printValue,
  type OutputContext,
  type OutputFormat,
} from "./output.js";
import { knownHostsFile } from "./paths.js";
import { credentialName, importLocalProfile } from "./profiles.js";
import {
  connectCommand,
  ensureIdentity,
  runSandboxSsh,
  trustHostKey,
  workspaceCommand,
} from "./ssh.js";

type GlobalOptions = {
  host?: string;
  output: OutputFormat;
  quiet: boolean;
  noColor: boolean;
};
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
  secret put|list|get|delete
  profile import|list|get|delete|set-default
  logs
  completions bash|zsh
  version
`;

const parseGlobals = (argv: string[]) => {
  const separator = argv.indexOf("--");
  const before = separator < 0 ? argv : argv.slice(0, separator);
  const trailing = separator < 0 ? [] : argv.slice(separator + 1);
  const options: GlobalOptions = {
    output: "table",
    quiet: false,
    noColor: false,
  };
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
    else if (value === "--no-color") options.noColor = true;
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

let outputContext: OutputContext = createOutputContext();

const main = async () => {
  const parsed = parseGlobals(process.argv.slice(2));
  outputContext = createOutputContext({
    format: parsed.options.output,
    noColor: parsed.options.noColor,
    quiet: parsed.options.quiet,
  });
  const [group, action, ...rest] = parsed.args;
  if (!group || group === "help" || group === "--help" || group === "-h") {
    console.log(usage);
    return;
  }

  const selectedHost = () => {
    const config = loadConfig();
    return resolveHost(config, parsed.options.host);
  };

  const selectedSecretHost = () => {
    const selected = selectedHost();
    if (selected.config.transport === "direct") {
      const endpoint = new URL(selected.config.apiEndpoint);
      const local = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
        endpoint.hostname,
      );
      if (endpoint.protocol !== "https:" && !local) {
        throw new Error(
          "Secret and profile uploads require HTTPS, SSH transport, or a loopback endpoint",
        );
      }
    }
    return selected;
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
      printSuccess(outputContext, `Host '${name}' added and selected`, {
        name,
        selected: true,
      });
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
      printHosts(rows, outputContext);
      return;
    }
    if (action === "select") {
      const name = requirePosition(rest, 0, "host name");
      saveConfig(selectHost(loadConfig(), name));
      printSuccess(outputContext, `Host '${name}' selected`, {
        name,
        selected: true,
      });
      return;
    }
    if (action === "info") {
      const config = loadConfig();
      const selected = resolveHost(config, rest[0]);
      printProperties(
        { name: selected.name, ...selected.config, token: "<redacted>" },
        outputContext,
      );
      return;
    }
    if (action === "remove") {
      const name = requirePosition(rest, 0, "host name");
      saveConfig(removeHost(loadConfig(), name));
      printSuccess(outputContext, `Host '${name}' removed`, { name });
      return;
    }
    throw new Error("Usage: agentctl host add|list|select|info|remove");
  }

  if (group === "status") {
    const selected = selectedHost();
    const status = await withGatewayClient(selected.config, (client) =>
      client.status(),
    );
    printStatus(selected.name, status, outputContext);
    return;
  }

  if (group === "secret") {
    const selected = selectedSecretHost();
    if (action === "list") {
      printSecrets(
        await withGatewayClient(selected.config, (client) =>
          client.listSecrets(),
        ),
        outputContext,
      );
      return;
    }
    if (action === "get") {
      const name = requirePosition(rest, 0, "secret name");
      printSecret(
        await withGatewayClient(selected.config, (client) =>
          client.getSecret(name),
        ),
        outputContext,
      );
      return;
    }
    if (action === "put") {
      const options = parseOptions(rest, parsed.trailing, {
        "--type": { key: "type" },
        "--from-file": { key: "fromFile" },
        "--expected-version": { key: "expectedVersion" },
      });
      const name = requirePosition(options.positionals, 0, "secret name");
      const filename = options.values.fromFile;
      if (!filename) throw new Error("Missing --from-file");
      const input = putSecretRequestSchema.parse({
        type: secretTypeSchema.parse(options.values.type ?? "opaque"),
        valueBase64: readFileSync(filename).toString("base64"),
        ...(options.values.expectedVersion
          ? { expectedVersion: Number(options.values.expectedVersion) }
          : {}),
      });
      printSecret(
        await withGatewayClient(selected.config, (client) =>
          client.putSecret(name, input),
        ),
        outputContext,
      );
      return;
    }
    if (action === "delete") {
      const name = requirePosition(rest, 0, "secret name");
      const deleted = await withGatewayClient(selected.config, (client) =>
        client.deleteSecret(name),
      );
      printSuccess(outputContext, `Secret '${name}' deleted`, deleted);
      return;
    }
    throw new Error("Usage: agentctl secret put|list|get|delete");
  }

  if (group === "profile") {
    const selected = selectedSecretHost();
    if (action === "list") {
      printProfiles(
        await withGatewayClient(selected.config, (client) =>
          client.listProfiles(),
        ),
        outputContext,
      );
      return;
    }
    if (action === "get") {
      const name = requirePosition(rest, 0, "profile name");
      printProfile(
        await withGatewayClient(selected.config, (client) =>
          client.getProfile(name),
        ),
        outputContext,
      );
      return;
    }
    if (action === "import") {
      const options = parseOptions(rest, parsed.trailing, {
        "--agent": { key: "agent" },
        "--include-auth": { key: "includeAuth", boolean: true },
        "--set-default": { key: "setDefault", boolean: true },
      });
      const name = requirePosition(options.positionals, 0, "profile name");
      const agent = agentTypeSchema.parse(options.values.agent);
      const imported = importLocalProfile(
        agent,
        options.flags.has("includeAuth"),
      );
      const secretNames: string[] = [];
      for (const credential of imported.credentials) {
        const secretName = credentialName(name, credential.nameSuffix);
        await withGatewayClient(selected.config, (client) =>
          client.putSecret(
            secretName,
            putSecretRequestSchema.parse({
              type: credential.type,
              valueBase64: credential.value.toString("base64"),
            }),
          ),
        );
        secretNames.push(secretName);
      }
      const profile = await withGatewayClient(selected.config, (client) =>
        client.putProfile(
          name,
          putAgentProfileRequestSchema.parse({
            agent,
            bundleBase64: imported.bundleBase64,
            secretNames,
          }),
        ),
      );
      if (options.flags.has("setDefault")) {
        await withGatewayClient(selected.config, (client) =>
          client.setDefaultProfile(agent, name),
        );
      }
      printProfile(
        {
          ...profile,
          isDefault: options.flags.has("setDefault") || profile.isDefault,
        },
        outputContext,
      );
      return;
    }
    if (action === "delete") {
      const name = requirePosition(rest, 0, "profile name");
      const deleted = await withGatewayClient(selected.config, (client) =>
        client.deleteProfile(name),
      );
      printSuccess(outputContext, `Profile '${name}' deleted`, deleted);
      return;
    }
    if (action === "set-default") {
      const agent = agentTypeSchema.parse(
        requirePosition(rest, 0, "agent (codex or opencode)"),
      );
      const name = requirePosition(rest, 1, "profile name");
      const profile = await withGatewayClient(selected.config, (client) =>
        client.setDefaultProfile(agent, name),
      );
      printSuccess(
        outputContext,
        `Default ${agent} profile set to '${name}'`,
        profile,
      );
      return;
    }
    throw new Error(
      "Usage: agentctl profile import|list|get|delete|set-default",
    );
  }

  const sandboxGroup = group === "sandbox" || group === "sb";
  if (sandboxGroup && action === "create") {
    const options = parseOptions(rest, parsed.trailing, {
      "--name": { key: "name" },
      "--image": { key: "image" },
      "--repo": { key: "repo" },
      "--cpu": { key: "cpu" },
      "--memory": { key: "memory" },
      "--profile": { key: "profile" },
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
      ...(options.values.profile
        ? { profileName: options.values.profile }
        : {}),
      publicKey: key.publicKey,
      command: options.trailing,
    });
    printSandbox(
      await withGatewayClient(selected.config, (client) =>
        client.create(request),
      ),
      outputContext,
      { operation: "create" },
    );
    return;
  }

  if (sandboxGroup && action === "list") {
    const selected = selectedHost();
    printSandboxes(
      await withGatewayClient(selected.config, (client) => client.list()),
      outputContext,
    );
    return;
  }

  if (sandboxGroup && action === "get") {
    const id = requirePosition(rest, 0, "sandbox name or ID");
    const selected = selectedHost();
    printSandbox(
      await withGatewayClient(selected.config, (client) => client.get(id)),
      outputContext,
      { operation: "get" },
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
      outputContext,
      { operation: action },
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
    const deleteVolume = options.flags.has("deleteVolume");
    printSandbox(
      await withGatewayClient(selected.config, (client) =>
        client.delete(id, deleteVolume),
      ),
      outputContext,
      { operation: "delete", deleteVolume },
    );
    return;
  }

  if (sandboxGroup && (action === "connect" || action === "exec")) {
    const options = parseOptions(
      rest,
      parsed.trailing,
      action === "connect"
        ? { "--shell": { key: "shell", boolean: true } }
        : {},
    );
    const id = requirePosition(options.positionals, 0, "sandbox name or ID");
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
          : connectCommand(options.flags.has("shell")),
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
    printSuccess(
      outputContext,
      `OpenSSH and gateway '${selected.name}' are ready`,
    );
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
  printError(
    error,
    outputContext,
    error instanceof GatewayError ? error.code : undefined,
  );
  process.exitCode = 1;
});

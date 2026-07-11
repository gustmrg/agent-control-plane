import { styleText } from "node:util";

import type {
  AgentProfile,
  Sandbox,
  SecretMetadata,
  StatusResponse,
} from "@agent-control/contracts";

export type OutputFormat = "table" | "json";
export type SandboxOperation = "create" | "get" | "start" | "stop" | "delete";

export type OutputContext = {
  format: OutputFormat;
  color: boolean;
  quiet: boolean;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
};

type OutputContextOptions = {
  format?: OutputFormat;
  noColor?: boolean;
  quiet?: boolean;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
};

type HostRow = {
  name: string;
  active: boolean;
  transport: string;
  target: string;
};

const hasTty = (stream: NodeJS.WritableStream) =>
  Boolean((stream as NodeJS.WriteStream).isTTY);

export const createOutputContext = (
  options: OutputContextOptions = {},
): OutputContext => {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;
  const format = options.format ?? "table";
  return {
    format,
    color:
      format !== "json" &&
      !options.noColor &&
      env.NO_COLOR === undefined &&
      hasTty(stdout),
    quiet: options.quiet ?? false,
    stdout,
    stderr,
  };
};

const paint = (
  context: OutputContext,
  format: Parameters<typeof styleText>[0],
  value: string,
) =>
  context.color ? styleText(format, value, { validateStream: false }) : value;

const writeLine = (stream: NodeJS.WritableStream, value = "") => {
  stream.write(`${value}\n`);
};

export const printValue = (value: unknown, context: OutputContext) => {
  writeLine(
    context.stdout,
    context.format === "json" ? JSON.stringify(value, null, 2) : String(value),
  );
};

export const printProperties = (
  value: Record<string, unknown>,
  context: OutputContext,
) => {
  if (context.format === "json") {
    printValue(value, context);
    return;
  }
  printDetails(
    context,
    Object.entries(value).map(([key, entry]) => [
      key,
      entry === null || entry === undefined ? "-" : String(entry),
    ]),
  );
};

const formatDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  const pad = (part: number) => String(part).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
};

const stateColor = (state: Sandbox["observedState"]) => {
  if (state === "running") return "green" as const;
  if (state === "starting" || state === "stopped") return "yellow" as const;
  if (state === "failed") return "red" as const;
  return "gray" as const;
};

const profileName = (sandbox: Sandbox) =>
  (sandbox as Sandbox & { profileName?: string | null }).profileName ?? "-";

type TableCell = { raw: string; rendered: string };

const cell = (raw: string, rendered = raw): TableCell => ({ raw, rendered });

const renderTable = (rows: TableCell[][]) => {
  const widths = rows[0]!.map((_, index) =>
    Math.max(...rows.map((row) => row[index]!.raw.length)),
  );
  return rows.map((row) =>
    row
      .map(
        (value, index) =>
          `${value.rendered}${" ".repeat(widths[index]! - value.raw.length)}`,
      )
      .join("  ")
      .trimEnd(),
  );
};

export const printSandboxes = (
  sandboxes: Sandbox[],
  context: OutputContext,
) => {
  if (context.format === "json") {
    printValue(sandboxes, context);
    return;
  }
  if (sandboxes.length === 0) {
    writeLine(context.stdout, paint(context, "gray", "No sandboxes"));
    return;
  }
  const header = ["NAME", "STATE", "IMAGE", "PROFILE", "CREATED"].map((value) =>
    cell(value, paint(context, "bold", value)),
  );
  const rows = sandboxes.map((sandbox) => [
    cell(sandbox.name, paint(context, "cyan", sandbox.name)),
    cell(
      sandbox.observedState,
      paint(context, stateColor(sandbox.observedState), sandbox.observedState),
    ),
    cell(sandbox.image),
    cell(profileName(sandbox)),
    cell(formatDate(sandbox.createdAt)),
  ]);
  for (const line of renderTable([header, ...rows]))
    writeLine(context.stdout, line);
};

const detailRows = (sandbox: Sandbox) => [
  ["Name", sandbox.name],
  ["ID", sandbox.id],
  ["State", sandbox.observedState],
  ["Desired", sandbox.desiredState],
  ["Image", sandbox.image],
  ["Repository", sandbox.repositoryUrl ?? "-"],
  ["Profile", profileName(sandbox)],
  ["Created", formatDate(sandbox.createdAt)],
  ...(sandbox.lastError ? [["Error", sandbox.lastError]] : []),
];

const printDetails = (
  context: OutputContext,
  rows: string[][],
  sandbox?: Sandbox,
) => {
  const width = Math.max(...rows.map(([label]) => label!.length));
  for (const [label, rawValue] of rows) {
    const value =
      label === "State" && sandbox
        ? paint(context, stateColor(sandbox.observedState), rawValue!)
        : label === "Name" || label === "ID"
          ? paint(context, "cyan", rawValue!)
          : label === "Error"
            ? paint(context, "red", rawValue!)
            : rawValue!;
    writeLine(
      context.stdout,
      `${paint(context, "bold", `${label!.padEnd(width)}:`)} ${value}`,
    );
  }
};

const operationVerb = (operation: SandboxOperation) =>
  ({
    create: "created",
    get: "",
    start: "started",
    stop: "stopped",
    delete: "deleted",
  })[operation];

export const printSandbox = (
  sandbox: Sandbox,
  context: OutputContext,
  options: { operation: SandboxOperation; deleteVolume?: boolean },
) => {
  if (context.format === "json") {
    printValue(sandbox, context);
    return;
  }
  if (options.operation === "get") {
    printDetails(context, detailRows(sandbox), sandbox);
    return;
  }
  if (context.quiet) return;
  const verb = operationVerb(options.operation);
  writeLine(
    context.stdout,
    `${paint(context, "green", "✓")} Sandbox ${paint(context, "cyan", `'${sandbox.name}'`)} ${verb}`,
  );
  if (options.operation === "create") {
    printDetails(context, detailRows(sandbox), sandbox);
    return;
  }
  if (options.operation === "delete") {
    printDetails(context, [
      ["ID", sandbox.id],
      ["Volume", options.deleteVolume ? "deleted" : "preserved"],
    ]);
  }
};

export const printSuccess = (
  context: OutputContext,
  message: string,
  json?: unknown,
) => {
  if (context.format === "json") {
    printValue(json ?? { status: "ok", message }, context);
    return;
  }
  if (!context.quiet)
    writeLine(context.stdout, `${paint(context, "green", "✓")} ${message}`);
};

export const printStatus = (
  host: string,
  status: StatusResponse,
  context: OutputContext,
) => {
  if (context.format === "json") {
    printValue({ host, ...status }, context);
    return;
  }
  printSuccess(context, `Gateway '${host}' is ready`);
  printDetails(context, [
    ["Docker", status.docker],
    ["Database", status.database],
    ["Version", status.version],
  ]);
};

export const printHosts = (hosts: HostRow[], context: OutputContext) => {
  if (context.format === "json") {
    printValue(hosts, context);
    return;
  }
  if (hosts.length === 0) {
    writeLine(context.stdout, paint(context, "gray", "No hosts"));
    return;
  }
  const header = ["", "NAME", "TRANSPORT", "TARGET"].map((value) =>
    cell(value, paint(context, "bold", value)),
  );
  const rows = hosts.map((host) => [
    cell(host.active ? "*" : ""),
    cell(host.name, paint(context, "cyan", host.name)),
    cell(host.transport),
    cell(host.target),
  ]);
  for (const line of renderTable([header, ...rows]))
    writeLine(context.stdout, line);
};

export const printSecrets = (
  secrets: SecretMetadata[],
  context: OutputContext,
) => {
  if (context.format === "json") {
    printValue(secrets, context);
    return;
  }
  if (secrets.length === 0) {
    writeLine(context.stdout, paint(context, "gray", "No secrets"));
    return;
  }
  const header = ["NAME", "TYPE", "BACKEND", "VERSION", "UPDATED"].map(
    (value) => cell(value, paint(context, "bold", value)),
  );
  const rows = secrets.map((secret) => [
    cell(secret.name, paint(context, "cyan", secret.name)),
    cell(secret.type),
    cell(secret.backend),
    cell(String(secret.version)),
    cell(formatDate(secret.updatedAt)),
  ]);
  for (const line of renderTable([header, ...rows]))
    writeLine(context.stdout, line);
};

export const printSecret = (secret: SecretMetadata, context: OutputContext) => {
  if (context.format === "json") {
    printValue(secret, context);
    return;
  }
  printDetails(context, [
    ["Name", secret.name],
    ["Type", secret.type],
    ["Backend", secret.backend],
    ["Version", String(secret.version)],
    ["Updated", formatDate(secret.updatedAt)],
  ]);
};

export const printProfiles = (
  profiles: AgentProfile[],
  context: OutputContext,
) => {
  if (context.format === "json") {
    printValue(profiles, context);
    return;
  }
  if (profiles.length === 0) {
    writeLine(context.stdout, paint(context, "gray", "No profiles"));
    return;
  }
  const header = ["", "NAME", "AGENT", "VERSION", "CREDENTIALS"].map((value) =>
    cell(value, paint(context, "bold", value)),
  );
  const rows = profiles.map((profile) => [
    cell(profile.isDefault ? "*" : ""),
    cell(profile.name, paint(context, "cyan", profile.name)),
    cell(profile.agent),
    cell(String(profile.version)),
    cell(profile.credentials.map((value) => value.type).join(",") || "-"),
  ]);
  for (const line of renderTable([header, ...rows]))
    writeLine(context.stdout, line);
};

export const printProfile = (profile: AgentProfile, context: OutputContext) => {
  if (context.format === "json") {
    printValue(profile, context);
    return;
  }
  printDetails(context, [
    ["Name", profile.name],
    ["Agent", profile.agent],
    ["Version", String(profile.version)],
    ["Default", profile.isDefault ? "yes" : "no"],
    [
      "Credentials",
      profile.credentials
        .map((value) => `${value.type}:${value.secretName}`)
        .join(", ") || "-",
    ],
    ["Updated", formatDate(profile.updatedAt)],
  ]);
};

export const printError = (
  error: unknown,
  context: OutputContext,
  code?: string,
) => {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = code ? `[${code}] ` : "";
  writeLine(
    context.stderr,
    `${paint(context, "red", "✗")} ${paint(context, "red", `${prefix}${message}`)}`,
  );
};

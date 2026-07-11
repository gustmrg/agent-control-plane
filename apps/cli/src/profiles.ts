import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import type {
  AgentType,
  ProfileBundle,
  SecretType,
} from "@agent-control/contracts";

const MAX_FILES = 5000;
const MAX_BYTES = 50 * 1024 * 1024;

export type ImportedCredential = {
  nameSuffix: string;
  type: SecretType;
  value: Buffer;
};

export type LocalProfileImport = {
  bundleBase64: string;
  credentials: ImportedCredential[];
};

type BundleFile = ProfileBundle["files"][number];

const modeFor = (mode: number) => (mode & 0o111 ? 0o755 : 0o644);

const addFile = (
  files: BundleFile[],
  source: string,
  target: string,
  state: { bytes: number },
) => {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink())
    throw new Error(`Profile imports do not allow symlinks: ${source}`);
  if (!stat.isFile()) return;
  const content = readFileSync(source);
  state.bytes += content.byteLength;
  if (state.bytes > MAX_BYTES)
    throw new Error("Profile files may not exceed 50 MiB in total");
  if (files.length >= MAX_FILES)
    throw new Error(`Profile imports may not exceed ${MAX_FILES} files`);
  files.push({
    path: target.split(sep).join("/"),
    contentBase64: content.toString("base64"),
    mode: modeFor(stat.mode),
  });
};

const addTree = (
  files: BundleFile[],
  sourceRoot: string,
  targetRoot: string,
  state: { bytes: number },
) => {
  if (!existsSync(sourceRoot)) return;
  const rootStat = lstatSync(sourceRoot);
  if (rootStat.isSymbolicLink())
    throw new Error(`Profile imports do not allow symlinks: ${sourceRoot}`);
  if (!rootStat.isDirectory()) return;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const source = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Profile imports do not allow symlinks: ${source}`);
      if (entry.isDirectory()) visit(source);
      else if (entry.isFile())
        addFile(
          files,
          source,
          join(targetRoot, relative(sourceRoot, source)),
          state,
        );
    }
  };
  visit(sourceRoot);
};

const readJson = (filename: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filename, "utf8"));
  } catch {
    throw new Error(`Authentication file is not valid JSON: ${filename}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`Authentication file must contain an object: ${filename}`);
  return parsed as Record<string, unknown>;
};

const importCodexAuth = (filename: string): ImportedCredential[] => {
  if (!existsSync(filename))
    throw new Error(
      `Codex auth was not found at ${filename}. Configure cli_auth_credentials_store = "file" and run codex login.`,
    );
  const auth = readJson(filename);
  const tokens = auth.tokens;
  if (
    auth.auth_mode !== "chatgpt" ||
    !tokens ||
    typeof tokens !== "object" ||
    Array.isArray(tokens) ||
    typeof (tokens as Record<string, unknown>).refresh_token !== "string" ||
    !(tokens as Record<string, string>).refresh_token
  ) {
    throw new Error(
      "Codex profile import requires ChatGPT auth with a refresh token; API key auth is not supported",
    );
  }
  return [
    {
      nameSuffix: "codex-auth",
      type: "codex-auth",
      value: readFileSync(filename),
    },
  ];
};

const importOpenCodeAuth = (filename: string): ImportedCredential[] => {
  if (!existsSync(filename))
    throw new Error(`OpenCode auth was not found at ${filename}`);
  const auth = readJson(filename);
  const credentials: ImportedCredential[] = [];
  const openai = auth.openai;
  if (openai && typeof openai === "object" && !Array.isArray(openai)) {
    const entry = openai as Record<string, unknown>;
    if (entry.type === "api")
      throw new Error(
        "OpenAI API keys are not supported; connect OpenCode with ChatGPT Plus/Pro OAuth",
      );
    if (
      entry.type === "oauth" &&
      typeof entry.refresh === "string" &&
      entry.refresh
    ) {
      credentials.push({
        nameSuffix: "openai-oauth",
        type: "opencode-openai-oauth",
        value: Buffer.from(JSON.stringify(entry)),
      });
    }
  }
  const go = auth["opencode-go"];
  if (go && typeof go === "object" && !Array.isArray(go)) {
    const entry = go as Record<string, unknown>;
    if (entry.type === "api" && typeof entry.key === "string" && entry.key) {
      credentials.push({
        nameSuffix: "opencode-go",
        type: "opencode-go-key",
        value: Buffer.from(JSON.stringify(entry)),
      });
    }
  }
  if (credentials.length === 0)
    throw new Error(
      "OpenCode auth contains neither OpenAI OAuth nor an OpenCode Go subscription key",
    );
  return credentials;
};

export const credentialName = (profileName: string, suffix: string) => {
  const prefixLength = 63 - suffix.length - 1;
  const prefix = profileName.slice(0, prefixLength).replace(/-+$/, "");
  return `${prefix}-${suffix}`;
};

export const importLocalProfile = (
  agent: AgentType,
  includeAuth: boolean,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): LocalProfileImport => {
  const home = resolve(options.home ?? homedir());
  const env = options.env ?? process.env;
  const files: BundleFile[] = [];
  const state = { bytes: 0 };
  addTree(files, join(home, ".agents", "skills"), ".agents/skills", state);

  let credentials: ImportedCredential[] = [];
  if (agent === "codex") {
    const codexHome = resolve(env.CODEX_HOME ?? join(home, ".codex"));
    const config = join(codexHome, "config.toml");
    if (existsSync(config)) addFile(files, config, ".codex/config.toml", state);
    if (includeAuth)
      credentials = importCodexAuth(join(codexHome, "auth.json"));
  } else {
    const configHome = resolve(env.XDG_CONFIG_HOME ?? join(home, ".config"));
    const opencodeConfig = join(configHome, "opencode");
    for (const filename of [
      "opencode.json",
      "opencode.jsonc",
      "tui.json",
      "tui.jsonc",
    ]) {
      const source = join(opencodeConfig, filename);
      if (existsSync(source))
        addFile(files, source, `.config/opencode/${filename}`, state);
    }
    for (const directory of [
      "agents",
      "commands",
      "modes",
      "plugins",
      "skills",
      "tools",
      "themes",
    ])
      addTree(
        files,
        join(opencodeConfig, directory),
        `.config/opencode/${directory}`,
        state,
      );
    if (includeAuth) {
      const dataHome = resolve(
        env.XDG_DATA_HOME ?? join(home, ".local", "share"),
      );
      credentials = importOpenCodeAuth(join(dataHome, "opencode", "auth.json"));
    }
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  const bundle: ProfileBundle = { version: 1, files };
  return {
    bundleBase64: Buffer.from(JSON.stringify(bundle)).toString("base64"),
    credentials,
  };
};

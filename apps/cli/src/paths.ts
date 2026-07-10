import { homedir } from "node:os";
import { join } from "node:path";

export const configDirectory = () =>
  join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "agent-control",
  );

export const configFile = () => join(configDirectory(), "config.toml");
export const keysDirectory = () => join(configDirectory(), "keys");
export const identityFile = () => join(keysDirectory(), "sandbox_ed25519");
export const knownHostsFile = () => join(configDirectory(), "known_hosts");

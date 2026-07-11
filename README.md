# Agent Control

Agent Control is a single-user control plane for running persistent coding-agent sandboxes on a local Docker host or Linux VPS. A small CLI manages hosts and sandboxes; the gateway owns Docker lifecycle and SQLite state; each sandbox is reached through key-only SSH.

## Requirements

Client:

- Node.js 24 LTS
- OpenSSH client
- pnpm for installing the development build

Gateway host:

- Linux with Docker Engine and the Docker Compose plugin
- OpenSSH server when controlling it remotely

## Build the CLI

```bash
pnpm install
pnpm build
cd apps/cli
pnpm add -g .
agentctl version
```

## Deploy locally or on a VPS

Create the deployment environment:

```bash
cp deploy/.env.example deploy/.env
openssl rand -hex 32
openssl rand 32 > deploy/master.key
chmod 600 deploy/master.key
```

Put the hex value in `AGENT_CONTROL_API_TOKEN`. The binary `master.key` encrypts agent credentials at rest and is mounted read-only into the gateway. Back it up separately from the SQLite database; losing it makes the encrypted credentials unrecoverable. Then build the sandbox and start the gateway:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yml --profile build-only build sandbox-image
docker compose --env-file deploy/.env -f deploy/compose.yml up -d gateway
docker compose --env-file deploy/.env -f deploy/compose.yml ps
```

Load the deployment token into the current shell before registering the gateway:

```bash
set -a
source deploy/.env
set +a
```

The API is published only on host loopback. Do not change the Compose binding to `0.0.0.0` for the v1 single-user deployment.

## Register a host

Local gateway:

```bash
printf '%s' "$AGENT_CONTROL_API_TOKEN" \
  | agentctl host add local --endpoint http://127.0.0.1:7070 --token-stdin
```

Remote gateway, using an existing `~/.ssh/config` alias called `homelab`:

```bash
printf '%s' "$AGENT_CONTROL_API_TOKEN" \
  | agentctl host add home --ssh homelab --token-stdin
agentctl host select home
agentctl status
```

The CLI stores registrations with owner-only permissions under `~/.config/agent-control` and opens an SSH tunnel for each remote API operation.

## Sandbox workflow

```bash
agentctl sandbox create --name demo --repo https://github.com/example/project.git -- codex
agentctl sandbox list
agentctl sandbox connect demo
agentctl sandbox connect demo --shell
agentctl sandbox exec demo -- git status
agentctl logs demo --tail
agentctl sandbox stop demo
agentctl sandbox start demo
agentctl sandbox delete demo
```

The human-readable output uses colors only on a TTY. `NO_COLOR=1` and `--no-color` disable them; `--output json` always emits complete, uncolored objects for automation. Delete summaries intentionally omit the sandbox creation date, while JSON preserves `createdAt`.

`sandbox connect` automatically attaches to the persistent `agent` tmux session. If the initial command has exited or no session was created, it opens a login shell instead. To skip the session and open a shell directly, use:

```bash
agentctl sandbox connect demo --shell
```

Deleting a sandbox preserves its named state volume by default. Permanently remove it with:

```bash
agentctl sandbox delete demo --delete-volume
```

## Agent profiles and subscription authentication

Profiles are versioned snapshots of an agent's allowed configuration plus global skills from `~/.agents/skills`. Authentication is stored separately in the encrypted local secret backend. A sandbox pins the profile version selected when it is created.

Import Codex configuration and ChatGPT subscription authentication:

```bash
# Codex must use file credentials so agentctl can import auth.json.
# Add cli_auth_credentials_store = "file" to ~/.codex/config.toml, then run codex login.
agentctl profile import codex-main --agent codex --include-auth --set-default
agentctl sandbox create --name codex-demo --repo https://github.com/example/project.git -- codex
```

Import OpenCode configuration, ChatGPT Plus/Pro OAuth, and an OpenCode Go subscription:

```bash
# First authenticate the desired providers with `opencode auth login`.
agentctl profile import opencode-main --agent opencode --include-auth --set-default
agentctl sandbox create --name opencode-demo --repo https://github.com/example/project.git -- opencode
```

The OpenCode importer reads `~/.local/share/opencode/auth.json` (or `$XDG_DATA_HOME/opencode/auth.json`) and treats the entries independently:

- `openai` must be OAuth. OpenAI API keys are rejected in v1.
- `opencode-go` may be the static API key issued for the OpenCode Go subscription.
- Other providers are not copied into the profile. If present in a sandbox auth file, they are preserved during managed OpenCode auth updates.

OAuth credentials are leased exclusively while a sandbox is active because their refresh state can change. `opencode-go` is static and may be shared by multiple sandboxes. On stop or delete, mutable auth is written back before the lease is released. A failed write-back leaves the sandbox stopped, preserves its volume, and retains the lease for recovery.

Use an explicit profile to override an agent default:

```bash
agentctl profile list
agentctl sandbox create --name alternate --profile codex-work -- codex
```

Raw secret management is also available for controlled workflows:

```bash
agentctl secret put custom-value --type opaque --from-file ./value.bin
agentctl secret list
agentctl secret get custom-value
agentctl secret delete custom-value
```

Secret/profile uploads are accepted by the CLI only over the built-in SSH tunnel, HTTPS, or a loopback endpoint. The Compose deployment keeps the HTTP API on loopback. Do not expose plain HTTP on a network interface.

When TLS terminates at a trusted reverse proxy, set `AGENT_CONTROL_TRUST_PROXY=true` so the gateway can honor the proxy's HTTPS protocol information. Never enable this setting when untrusted clients can reach the gateway directly and forge forwarding headers.

The gateway can still run without `AGENT_CONTROL_MASTER_KEY_FILE`; ordinary sandbox operations continue, while secret/profile endpoints return `secrets_not_configured`.

### Security boundary for agent credentials

The local backend encrypts values with AES-256-GCM and stores only ciphertext in SQLite. Secret values are never returned by API responses or normal CLI output. The bootstrap helper writes files directly into the sandbox state volume with UID/GID 1000, `0700` directories, and `0600` auth files; values are not placed in container environment variables, labels, or create parameters.

This protects credentials at rest and from Docker metadata, but it does not make them invisible inside the sandbox. The `sandbox` user, the agent process, skills/plugins, and any code the agent executes can read the injected auth files. Only attach profiles to code you trust, and use separate accounts/subscriptions when stronger blast-radius isolation is required.

### Provider roadmap and OpenShell comparison

The implemented `SecretBackend` keeps storage replaceable. Recommended adapters, in priority order:

1. [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html) for AWS deployments, using workload identity/IAM and provider-side versions.
2. [Azure Key Vault](https://learn.microsoft.com/en-us/azure/key-vault/general/basic-concepts) for Azure deployments, using managed identity and RBAC.
3. [DigitalOcean Security Secrets](https://docs.digitalocean.com/reference/api/reference/security/) for workloads already operated through DigitalOcean's regional secrets API.
4. [OpenBao](https://openbao.org/) or [HashiCorp Vault](https://developer.hashicorp.com/vault/docs/secrets/kv) for local/on-prem installations needing policies, audit, HA, or dynamic credentials.
5. [Bitwarden Secrets Manager](https://bitwarden.com/help/manage-your-secrets-org/) when its machine-account workflow fits the deployment. Bitwarden is a valid local/self-hosted option, but official self-hosting of Secrets Manager requires an Enterprise organization and a separate Secrets Manager subscription. Vaultwarden is an unofficial password-manager server and does not advertise the Secrets Manager API among its supported features, so it is not treated as a compatible backend.

NVIDIA/OpenShell offers useful architectural patterns but is not a drop-in solution for these subscription sessions. Its gateway owns provider records, credential discovery/refresh, and delivers credentials through a privileged sandbox supervisor/proxy. The current local SQLite design protects the database files with mode `0600`, while its roadmap describes pluggable credential drivers. Agent Control adopts the adapter boundary, optimistic version checks, and runtime delivery ideas, but keeps full Codex/OpenCode subscription auth as encrypted files because these CLIs expect mutable `auth.json` state rather than only request-time provider API keys.

## Backup and restore

Stop the gateway before taking a consistent SQLite backup:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yml stop gateway
sudo tar -C /var/lib -czf agent-control-state.tgz agent-control
docker volume ls --filter label=agent-control.managed=true
docker compose --env-file deploy/.env -f deploy/compose.yml start gateway
```

Back up each required sandbox state volume separately. Restore the SQLite directory and volumes before starting the gateway; startup reconciliation will compare saved records with actual labeled Docker resources.

Back up `deploy/master.key` (or the external path configured by `AGENT_CONTROL_MASTER_KEY_FILE`) through a different protected channel. Never commit it or include it in the same archive as the encrypted database.

## Security boundary

- The gateway has Docker-socket access and must be treated as host-root-equivalent.
- Sandboxes never receive the Docker socket.
- Sandbox SSH ports bind only to host loopback.
- Password and root SSH login are disabled.
- The CLI pins a unique SSH host key for every sandbox.
- Sandbox containers run with dropped capabilities, `no-new-privileges`, and resource limits.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm format:check
```

Real Docker lifecycle checks require an available Docker daemon. The ordinary gateway API tests use a real temporary SQLite database and a fake runtime only at the external Docker boundary.

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
```

Put the generated value in `AGENT_CONTROL_API_TOKEN`, then build the sandbox and start the gateway:

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

`sandbox connect` automatically attaches to the persistent `agent` tmux session. If the initial command has exited or no session was created, it opens a login shell instead. To skip the session and open a shell directly, use:

```bash
agentctl sandbox connect demo --shell
```

Deleting a sandbox preserves its named state volume by default. Permanently remove it with:

```bash
agentctl sandbox delete demo --delete-volume
```

## Credentials in v1

Automatic cloning supports public HTTPS repositories. Authenticate private Git hosts and agent CLIs interactively after connecting. Agent and Git credentials live inside the sandbox state volume; the gateway does not store them in SQLite.

## Backup and restore

Stop the gateway before taking a consistent SQLite backup:

```bash
docker compose --env-file deploy/.env -f deploy/compose.yml stop gateway
sudo tar -C /var/lib -czf agent-control-state.tgz agent-control
docker volume ls --filter label=agent-control.managed=true
docker compose --env-file deploy/.env -f deploy/compose.yml start gateway
```

Back up each required sandbox state volume separately. Restore the SQLite directory and volumes before starting the gateway; startup reconciliation will compare saved records with actual labeled Docker resources.

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

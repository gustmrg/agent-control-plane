# Agent Control v1 Plan

## Status

Implemented as v0.1 on July 10, 2026. Contract, CLI, gateway API, and SQLite lifecycle tests pass locally; a clean Node.js 24 install and the real Docker/SSH end-to-end gate remain environment-dependent verification steps.

## Product Goal

Build a lean, single-user control plane for creating and managing disposable agent sandboxes on either the local machine or one remote Docker host.

The user installs one CLI, registers a local or SSH-accessible host, and then manages sandboxes with commands inspired by OpenShell:

```bash
agentctl host add home --ssh homelab --token-stdin
agentctl host select home

agentctl sandbox create \
  --name bill-fix \
  --repo https://github.com/example/project.git \
  -- codex

agentctl sandbox list
agentctl sandbox connect bill-fix
agentctl sandbox exec bill-fix -- git status
agentctl logs bill-fix --tail
agentctl sandbox stop bill-fix
agentctl sandbox delete bill-fix
```

## v1 Product Decisions

- One gateway controls one Docker host.
- The gateway is deployed with Docker Compose and creates sibling sandbox containers through the host Docker socket.
- Client machines use the CLI and the system OpenSSH client; they do not need Docker.
- Remote gateway traffic is carried through an automatically managed SSH tunnel.
- Each sandbox runs `sshd` and is published only on a random loopback port on the Docker host.
- The CLI uses the registered SSH target as a jump host to reach sandbox SSH ports.
- SQLite is the only v1 persistence backend.
- Docker is authoritative for actual runtime state; SQLite stores desired state and metadata.
- Each sandbox uses one named state volume for its home directory and workspace; it survives stop/start by default.
- TypeScript 7 is the compiler and type checker for every TypeScript package.
- The project is single-user. Multi-user authorization and tenancy are explicitly deferred.

## Suggested Technology Stack

| Area | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 24 LTS | Current production LTS; avoid Node 26 Current for the server baseline. |
| Language | TypeScript 7.0, strict ESM | Stable native compiler, fast builds, Node-native module model. |
| Package manager | pnpm workspace | Small monorepo, deterministic lockfile, shared local packages. |
| API | Fastify 5 | Typed Node server, built-in Pino logging, streaming support, low ceremony. |
| Runtime validation | Zod 4 | Shared request, response, configuration, and CLI-input validation. |
| CLI | Small internal command router | Keeps the v1 CLI dependency-free while preserving nested commands, aliases, and trailing command support. |
| CLI HTTP | Node built-in `fetch` | Avoid a separate HTTP client dependency. |
| SSH integration | System `ssh` via `node:child_process` | Reuses `~/.ssh/config`, SSH agents, ProxyJump, and platform hardening. |
| Docker integration | Dockerode | Mature Docker Engine API client over `/var/run/docker.sock`. |
| Persistence | Node `node:sqlite` with handwritten SQL migrations | Built into Node 24; avoids a native-addon install and no ORM is needed for the small schema. |
| Tests | Node `node:test` and `node:assert/strict` | Stable built-in test runner and minimal test dependencies. |
| Formatting | Prettier | Keep formatting independent from the TypeScript compiler API. |
| Logging | Pino through Fastify | Structured production logs without adding another logging stack. |
| Deployment | Dockerfile plus Docker Compose | One repeatable gateway deployment on local machines and VPS hosts. |

### TypeScript 7 Tooling Constraint

TypeScript 7.0 is stable, but it does not expose a stable programmatic compiler API. The initial toolchain must therefore avoid depending on tools that import TypeScript for parsing or semantic analysis.

For v1:

- Use `typescript` 7.0.x directly for `tsc` and `tsc --build`.
- Use explicit `rootDir` and `types` settings required by TypeScript 7 defaults.
- Use `module: "NodeNext"` and `moduleResolution: "NodeNext"`.
- Use Prettier for formatting.
- Use strict type checking as the primary static quality gate.
- Defer type-aware ESLint until its TypeScript 7 integration no longer requires a TypeScript 6 compatibility alias.
- Pin exact dependency versions in `pnpm-lock.yaml`; use the latest stable 7.0.x patch when bootstrapping.

Recommended compiler baseline:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "./src",
    "outDir": "./dist",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "noEmitOnError": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

## Repository Layout

```text
agent-control/
├── apps/
│   ├── cli/                    # agentctl executable
│   └── gateway/                # Fastify control plane
├── packages/
│   └── contracts/              # Zod schemas and shared DTO types
├── images/
│   └── sandbox/
│       ├── Dockerfile
│       └── entrypoint.sh
├── deploy/
│   ├── compose.yml
│   └── .env.example
├── migrations/                 # Ordered SQLite migrations
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── PLAN.md
```

Keep the workspace at three TypeScript packages. Do not add a generic `core`, `utils`, or SDK package until a real second consumer requires it.

## Runtime Architecture

### Client

The CLI is responsible for:

- Managing saved host registrations.
- Resolving the selected host.
- Starting and cleaning up SSH tunnels for remote API calls.
- Calling the gateway REST API.
- Formatting table, JSON, and quiet output.
- Invoking the system SSH client for `connect` and `exec`.
- Maintaining sandbox SSH known-host entries in its own file.

The CLI must not call the remote Docker daemon directly.

### Gateway

The gateway is responsible for:

- Authenticating API requests with a static bearer token.
- Validating sandbox names, images, repository URLs, resources, and commands.
- Creating, inspecting, starting, stopping, and deleting Docker containers.
- Creating and optionally deleting sandbox state volumes.
- Assigning sandbox SSH ports on host loopback only.
- Reading the generated sandbox SSH host public key.
- Persisting sandbox metadata in SQLite.
- Reconciling SQLite records with Docker containers at startup and periodically.
- Streaming Docker logs to CLI clients.
- Exposing health and readiness endpoints.

### Sandbox

The sandbox image is responsible for:

- Running as a dedicated non-root `sandbox` user for agent work.
- Starting `sshd` with password authentication disabled.
- Generating a unique SSH host key on first start.
- Installing the client public key into `authorized_keys`.
- Mounting the persistent state volume at `/home/sandbox`.
- Including Git, GitHub CLI, CA certificates, shell utilities, `tmux`, and selected agent harnesses.
- Optionally cloning a public repository into `/home/sandbox/workspace/repo` during first initialization.
- Starting the requested trailing command inside a named `tmux` session.
- Remaining alive when the SSH client disconnects.

## Host Registration and Resolution

Use a separate application registry that references, but does not replace, `~/.ssh/config`.

Default configuration path:

```text
~/.config/agent-control/config.toml
```

Example:

```toml
active_host = "home"

[hosts.home]
transport = "ssh"
ssh_target = "homelab"
api_address = "127.0.0.1:7070"
token = "..."

[hosts.local]
transport = "direct"
api_endpoint = "http://127.0.0.1:7070"
token = "..."
```

Host resolution order:

1. `--host` / `-H` on the current command.
2. `AGENTCTL_HOST` environment variable.
3. Saved `active_host`.
4. A registered `local` host, if present.

Commands:

```text
agentctl host add <name> --ssh <ssh-alias> --token-stdin
agentctl host add local --endpoint http://127.0.0.1:7070 --token-stdin
agentctl host list
agentctl host select <name>
agentctl host info [name]
agentctl host remove <name>
agentctl status
```

For SSH hosts, store the alias as entered. Let the system `ssh` command interpret `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`, and SSH-agent settings.

Configuration files containing gateway tokens must be created with owner-only permissions.

## Remote API Transport

For each remote API command:

1. Resolve the selected host registration.
2. Ask the OS for a free local TCP port.
3. Start:

   ```bash
   ssh -N \
     -L 127.0.0.1:<local-port>:127.0.0.1:7070 \
     <ssh-target>
   ```

4. Wait until the local forwarded port accepts connections.
5. Call the gateway through `http://127.0.0.1:<local-port>` with the bearer token.
6. Terminate the tunnel when the command completes.

The gateway API must bind to `127.0.0.1` on the host. Do not expose the v1 API publicly.

## Sandbox SSH Flow

### Creation

1. The CLI reads or creates its sandbox SSH key pair.
2. The CLI sends only the public key in the create request.
3. The gateway creates the sandbox with port `22/tcp` bound to a random port on host `127.0.0.1`.
4. The sandbox generates its SSH host key and reports ready.
5. The gateway reads the public host key and stores it with the assigned host port.
6. The CLI receives the sandbox connection metadata.

Default CLI key location:

```text
~/.config/agent-control/keys/sandbox_ed25519
```

### Connect

For a remote host, the CLI launches a command equivalent to:

```bash
ssh \
  -J <ssh-target> \
  -p <sandbox-host-port> \
  -i ~/.config/agent-control/keys/sandbox_ed25519 \
  -o UserKnownHostsFile=~/.config/agent-control/known_hosts \
  -o StrictHostKeyChecking=yes \
  sandbox@127.0.0.1
```

For a local host, omit the jump host.

The CLI must add a returned host key only after verifying that the gateway response is authenticated. Never use `StrictHostKeyChecking=no`.

### Exec

`sandbox exec` reuses the same SSH connection construction but appends the command after `--`. It propagates stdin, stdout, stderr, and the remote exit code.

## Command Surface

### Root

```text
agentctl status
agentctl version
agentctl completions <shell>
```

Global flags:

```text
-H, --host <name>
-o, --output table|json
--quiet
--no-color
```

### Host Commands

```text
agentctl host add
agentctl host list
agentctl host select
agentctl host info
agentctl host remove
```

### Sandbox Commands

```text
agentctl sandbox create [--name] [--image] [--repo] [--cpu] [--memory] -- [command...]
agentctl sandbox list
agentctl sandbox get <name-or-id>
agentctl sandbox connect <name-or-id>
agentctl sandbox exec <name-or-id> -- <command...>
agentctl sandbox start <name-or-id>
agentctl sandbox stop <name-or-id>
agentctl sandbox delete <name-or-id> [--delete-volume]
agentctl logs <name-or-id> [--tail] [--lines]
```

Rules:

- Support `sb` as an alias for `sandbox`.
- Everything after `--` is passed verbatim to the sandbox command.
- `list` supports `table` and `json` output from the first release.
- Destructive commands always require an explicit sandbox name or ID.
- `delete --delete-volume` requires confirmation on an interactive TTY or `--force` in automation.
- Do not add a TUI in v1.

## REST API

Prefix all application routes with `/v1`.

```text
GET    /healthz
GET    /readyz

GET    /v1/sandboxes
POST   /v1/sandboxes
GET    /v1/sandboxes/:id
POST   /v1/sandboxes/:id/start
POST   /v1/sandboxes/:id/stop
DELETE /v1/sandboxes/:id?deleteVolume=false
GET    /v1/sandboxes/:id/connection
GET    /v1/sandboxes/:id/logs?tail=false&lines=200
```

The contracts package owns all request and response schemas. Both CLI and gateway import the same Zod definitions.

Do not generate an SDK or OpenAPI client in v1. A small handwritten API client in the CLI is enough.

## Data Model

Start with one application table and one migration table.

### `sandboxes`

```text
id                    TEXT PRIMARY KEY
name                  TEXT NOT NULL UNIQUE
image                 TEXT NOT NULL
repository_url        TEXT NULL
initial_command_json  TEXT NOT NULL
desired_state         TEXT NOT NULL
container_id          TEXT NULL UNIQUE
state_volume          TEXT NOT NULL UNIQUE
ssh_host_port         INTEGER NULL
ssh_host_public_key   TEXT NULL
created_at            TEXT NOT NULL
updated_at            TEXT NOT NULL
deleted_at            TEXT NULL
last_error            TEXT NULL
```

### `schema_migrations`

```text
version       INTEGER PRIMARY KEY
applied_at    TEXT NOT NULL
```

Database requirements:

- Enable WAL mode.
- Enable foreign keys even before relationships are added.
- Set a busy timeout.
- Store timestamps as UTC ISO 8601 strings.
- Set the database, WAL, and SHM files to owner-only permissions.
- Keep secrets out of SQLite.
- Run embedded migrations before the gateway starts serving requests.

## Docker Resource Contract

Every managed container and volume receives labels:

```text
agent-control.managed=true
agent-control.sandbox-id=<uuid>
agent-control.sandbox-name=<name>
agent-control.resource=container|state
```

Container defaults:

- Non-privileged.
- No Docker socket mount.
- No host filesystem mounts other than the managed sandbox state volume.
- Drop all capabilities, adding back only what `sshd` demonstrably requires.
- `no-new-privileges` enabled.
- PID limit configured.
- Default CPU and memory limits configured by the gateway.
- Port 22 bound only to `127.0.0.1` with a random host port.
- Dedicated Docker network managed by the gateway.
- Restart policy `unless-stopped` or `no`; choose one during implementation and test stop/start semantics explicitly.

The gateway container is the only component allowed to mount the Docker socket.

## Repository and Credential Scope

Keep repository and provider credentials intentionally limited in v1:

- Automated startup cloning supports public HTTPS Git repositories.
- Private repository authentication is performed interactively after connection.
- Agent-provider authentication is performed interactively inside the sandbox.
- The sandbox home directory and workspace persist in the sandbox state volume so interactive logins survive stop/start.
- The gateway does not store GitHub tokens, model API keys, SSH private keys, or agent session credentials.
- Generic `--env` secret injection, credential profiles, SSH-agent forwarding, and GitHub App tokens are deferred until their threat model is defined.

## Reconciliation

On startup and on a fixed interval:

1. List Docker containers labeled `agent-control.managed=true`.
2. Match them to SQLite records by sandbox ID.
3. Refresh container ID, host port, and observed status.
4. Mark missing containers as failed or stopped according to desired state.
5. Report orphaned labeled containers in logs; do not delete them automatically in v1.
6. Never infer that a database status is current without checking Docker.

Keep observed Docker state out of the persisted schema where practical. Return it from live inspection in API responses.

## Implementation Phases

### Phase 1: Workspace and Contracts

Deliverables:

- Initialize the pnpm workspace.
- Pin Node 24 and TypeScript 7.
- Add shared TypeScript configuration.
- Add `apps/cli`, `apps/gateway`, and `packages/contracts`.
- Define Zod contracts for hosts, sandboxes, errors, and connection metadata.
- Add build, typecheck, format, and test scripts.
- Add the initial SQLite migration files.

Acceptance criteria:

- `pnpm typecheck` succeeds using TypeScript 7.
- `pnpm build` produces runnable ESM output for both applications.
- Contract validation tests cover accepted and rejected sandbox inputs.

### Phase 2: Gateway Persistence and Docker Lifecycle

Deliverables:

- Fastify gateway with bearer-token middleware.
- Health and readiness routes.
- SQLite initialization, migrations, WAL, permissions, and repository layer.
- Dockerode adapter behind an internal interface.
- Create, list, get, start, stop, and delete endpoints.
- Docker labels, sandbox state volumes, resource limits, and startup reconciliation.
- Structured lifecycle logging.

Acceptance criteria:

- Gateway starts from an empty persistent directory.
- A sandbox can be created, stopped, started, listed, and deleted through API tests.
- Restarting the gateway preserves records and reconciles them with Docker.
- Deleting a sandbox preserves its state volume unless explicitly requested.
- No sandbox receives the Docker socket.

### Phase 3: Sandbox Image and SSH

Deliverables:

- Debian/Ubuntu-based sandbox Dockerfile.
- Non-root sandbox user.
- OpenSSH server configured for keys only.
- Unique host-key generation.
- Git, GitHub CLI, `tmux`, Node.js, and selected agent harnesses.
- Persistent state-volume layout rooted at `/home/sandbox`.
- Optional public-repository clone during first initialization.
- Initial command launched inside `tmux`.
- Gateway readiness check and connection metadata endpoint.

Acceptance criteria:

- The gateway binds each sandbox SSH port only on host loopback.
- The generated client key can authenticate; password authentication fails.
- Two sandboxes generate different SSH host keys.
- Disconnecting SSH does not terminate a command running inside `tmux`.
- The home directory and workspace survive stop/start.

### Phase 4: Local CLI Workflow

Deliverables:

- Internal command hierarchy and help output.
- Local host registration and selection.
- API client and bearer authentication.
- Sandbox create/list/get/start/stop/delete commands.
- `connect` and `exec` using the system SSH client.
- CLI-managed SSH key and known-host files.
- Table and JSON output.
- Logs retrieval and tail streaming.

Acceptance criteria:

- A user can complete the full local lifecycle using only `agentctl` commands.
- `exec` preserves stdin/stdout/stderr and exit status.
- Unknown or changed sandbox host keys fail closed.
- JSON output is stable enough for shell scripts.

### Phase 5: Remote Host Workflow

Deliverables:

- SSH host registration referencing `~/.ssh/config` aliases.
- Host list/select/info/remove commands.
- Automatic API SSH-tunnel lifecycle.
- Remote sandbox connection using the saved host as jump host.
- Timeouts and actionable diagnostics for SSH, API, and Docker failures.
- `agentctl status` and a small `agentctl doctor` command.

Acceptance criteria:

- The client machine requires only Node, `agentctl`, and OpenSSH.
- The API remains bound to VPS loopback and is not publicly reachable.
- A saved SSH alias with custom user, key, port, or ProxyJump works without duplicating those settings.
- Tunnel subprocesses are cleaned up after success, failure, and interruption.

### Phase 6: Packaging and Operational Hardening

Deliverables:

- Production gateway Dockerfile.
- Versioned sandbox image.
- Compose deployment with a persistent bind mount and health check.
- `.env.example` and VPS setup documentation.
- Graceful gateway shutdown.
- SQLite backup and restore documentation.
- Shell completion generation.
- CI for typecheck, test, build, and container build.
- Release process for the npm CLI package and container images.

Acceptance criteria:

- A clean VPS can be prepared from the documentation.
- Recreating the gateway container preserves SQLite and sandbox records.
- A backup containing the SQLite database and sandbox state volumes can be restored.
- Published versions are visible through `agentctl version` and gateway status.

## Test Strategy

### Unit

- Host resolution priority.
- Configuration parsing and owner-only file modes.
- Sandbox-name, image, URL, resource, and command validation.
- Docker label generation.
- State-transition rules.
- SSH argument construction and shell-argument preservation.

### Gateway integration

- Fastify route tests with an in-memory or temporary SQLite database.
- Docker adapter tests using a fake adapter for failure paths.
- Real Docker lifecycle tests behind an explicit integration-test command.
- Reconciliation tests for missing, stopped, running, and orphaned containers.

### End to end

- Start the gateway through Compose.
- Register it as a local host.
- Create a sandbox.
- Wait for SSH readiness.
- Run a command through `sandbox exec`.
- Disconnect and reconnect to a `tmux` session.
- Stop/start and confirm workspace persistence.
- Delete the container, then explicitly delete the volume.
- Repeat through an SSH alias against a disposable remote Linux host when available.

## Explicit Non-Goals for v1

- Browser UI or code-server.
- PostgreSQL.
- Multiple gateway replicas or shared scheduling.
- Kubernetes, Podman, or MicroVM drivers.
- Multi-user accounts, roles, OIDC, or tenancy.
- Public API exposure.
- TUI dashboard.
- OpenShell-style supervisor relay.
- Network egress policy engine.
- Filesystem sandbox policy beyond Docker isolation and managed mounts.
- Credential provider profiles or secret rewriting.
- Inference routing.
- Automatic branches, commits, pushes, pull requests, or completion callbacks.
- Windows-host gateway support.
- Automatic cleanup of orphaned containers or volumes.
- Standalone native CLI executable; the first distribution can be an npm package requiring Node 24.

## Post-v1 Candidates

Prioritize only after the complete v1 workflow is proven:

1. Short-lived sandbox SSH certificates.
2. Supervisor-initiated relay so no per-sandbox port binding is needed.
3. Private Git repository credential profiles.
4. Per-sandbox outbound network policies.
5. Background task submission and completion state.
6. Resource quotas and expiration/garbage collection.
7. Standalone CLI binaries for macOS and Linux.
8. Multiple Docker hosts behind one logical control plane.
9. Web dashboard or terminal UI.
10. PostgreSQL only when multi-replica coordination becomes real.

## Definition of Done for Initial Version

The initial version is complete when a user can:

1. Deploy the gateway on a Linux VPS using Docker Compose.
2. Register that VPS using an existing `~/.ssh/config` alias.
3. Select it as the active host.
4. Create a sandbox from the default image.
5. Start an included coding-agent harness inside a persistent `tmux` session.
6. Connect to the sandbox through SSH without exposing its SSH port publicly.
7. Execute one-shot commands and stream logs.
8. Disconnect and reconnect without terminating the agent session.
9. Stop and restart the sandbox without losing its workspace.
10. Delete the sandbox while preserving or explicitly deleting its volume.
11. Restart the gateway and recover correct state by reconciling SQLite with Docker.

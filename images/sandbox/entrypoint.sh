#!/usr/bin/env bash
set -euo pipefail

SANDBOX_HOME="/home/sandbox"
WORKSPACE_DIR="${SANDBOX_HOME}/workspace"
REPOSITORY_DIR="${WORKSPACE_DIR}/repo"
export HOME="${SANDBOX_HOME}"
export USER="sandbox"
export LOGNAME="sandbox"

if [[ -z "${SANDBOX_PUBLIC_KEY:-}" ]]; then
  echo "SANDBOX_PUBLIC_KEY is required" >&2
  exit 1
fi

mkdir -p /run/sshd "${SANDBOX_HOME}/.ssh" "${WORKSPACE_DIR}"
chmod 0700 "${SANDBOX_HOME}/.ssh"
printf '%s\n' "${SANDBOX_PUBLIC_KEY}" > "${SANDBOX_HOME}/.ssh/authorized_keys"
chmod 0600 "${SANDBOX_HOME}/.ssh/authorized_keys"

if [[ ! -f /etc/ssh/ssh_host_ed25519_key ]]; then
  ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key
fi

chown -R sandbox:sandbox "${SANDBOX_HOME}"

if [[ -n "${SANDBOX_REPO_URL:-}" && ! -d "${REPOSITORY_DIR}/.git" ]]; then
  gosu sandbox git clone -- "${SANDBOX_REPO_URL}" "${REPOSITORY_DIR}"
fi

WORKDIR="${WORKSPACE_DIR}"
if [[ -d "${REPOSITORY_DIR}/.git" ]]; then
  WORKDIR="${REPOSITORY_DIR}"
fi

if [[ -n "${SANDBOX_COMMAND_JSON:-}" && "${SANDBOX_COMMAND_JSON}" != "[]" ]]; then
  mapfile -d '' COMMAND < <(
    node -e '
      const command = JSON.parse(process.env.SANDBOX_COMMAND_JSON);
      if (!Array.isArray(command) || command.some((item) => typeof item !== "string")) process.exit(2);
      for (const item of command) process.stdout.write(`${item}\0`);
    '
  )
  printf -v COMMAND_LINE '%q ' "${COMMAND[@]}"
  gosu sandbox tmux has-session -t agent 2>/dev/null \
    || gosu sandbox tmux new-session -d -s agent -c "${WORKDIR}" "${COMMAND_LINE}"
fi

exec /usr/sbin/sshd -D -e

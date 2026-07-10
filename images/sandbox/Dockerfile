FROM node:24-bookworm

ARG CODEX_VERSION=latest
ARG CLAUDE_CODE_VERSION=latest
ARG OPENCODE_VERSION=latest

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    gh \
    gosu \
    openssh-server \
    procps \
    tmux \
    vim-tiny \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global \
    "@openai/codex@${CODEX_VERSION}" \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

RUN if [ "${OPENCODE_VERSION}" = "latest" ]; then \
      curl -fsSL https://opencode.ai/install | bash; \
    else \
      curl -fsSL https://opencode.ai/install | bash -s -- --version "${OPENCODE_VERSION}"; \
    fi \
  && install -m 0755 /root/.opencode/bin/opencode /usr/local/bin/opencode

RUN userdel --remove node 2>/dev/null || true \
  && groupdel node 2>/dev/null || true \
  && useradd --create-home --shell /bin/bash --uid 1000 sandbox \
  && passwd -d sandbox \
  && mkdir -p /run/sshd \
  && sed -i \
    -e 's/^[#[:space:]]*PasswordAuthentication .*/PasswordAuthentication no/' \
    -e 's/^[#[:space:]]*KbdInteractiveAuthentication .*/KbdInteractiveAuthentication no/' \
    -e 's/^[#[:space:]]*PermitRootLogin .*/PermitRootLogin no/' \
    -e 's/^[#[:space:]]*PubkeyAuthentication .*/PubkeyAuthentication yes/' \
    -e 's/^[#[:space:]]*UsePAM .*/UsePAM no/' \
    -e 's/^[#[:space:]]*X11Forwarding .*/X11Forwarding no/' \
    -e 's/^[#[:space:]]*AllowAgentForwarding .*/AllowAgentForwarding no/' \
    -e 's/^[#[:space:]]*AllowTcpForwarding .*/AllowTcpForwarding yes/' \
    -e 's/^[#[:space:]]*GatewayPorts .*/GatewayPorts no/' \
    -e 's/^[#[:space:]]*PermitUserEnvironment .*/PermitUserEnvironment no/' \
    /etc/ssh/sshd_config \
  && printf '%s\n' \
    'PasswordAuthentication no' \
    'KbdInteractiveAuthentication no' \
    'ChallengeResponseAuthentication no' \
    'PermitRootLogin no' \
    'PubkeyAuthentication yes' \
    'AuthorizedKeysFile .ssh/authorized_keys' \
    'AllowUsers sandbox' \
    'X11Forwarding no' \
    'AllowAgentForwarding no' \
    'AllowTcpForwarding yes' \
    'GatewayPorts no' \
    'PermitUserEnvironment no' \
    >> /etc/ssh/sshd_config

COPY images/sandbox/entrypoint.sh /usr/local/bin/agent-control-sandbox
RUN chmod 0755 /usr/local/bin/agent-control-sandbox

EXPOSE 22

HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=12 \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/22'

ENTRYPOINT ["/usr/local/bin/agent-control-sandbox"]

#!/usr/bin/env bash
# Provisiona uma VM Ubuntu 24.04 do zero para o modo SFU.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "rode como root" >&2
  exit 1
fi

apt-get update && apt-get upgrade -y
apt-get install -y ca-certificates curl git ufw openssl

# ─── Docker ─────────────────────────────────────────────────────────────────
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# ─── Tuning de rede ─────────────────────────────────────────────────────────
# Buffers de socket UDP maiores. O default do Linux é de uma era em que
# ninguém encaminhava 8 Mbps de vídeo, e buffer pequeno vira perda de pacote
# sob rajada — que o usuário percebe como travadinha.
cat > /etc/sysctl.d/99-tela.conf <<'SYSCTL'
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576
net.core.netdev_max_backlog = 4096
# fq combate bufferbloat: sem isso, uma rajada de upload enfileira e a latência
# do próprio jogo sobe junto.
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
SYSCTL
sysctl --system

# ─── Segredos ───────────────────────────────────────────────────────────────
ENV_FILE=/opt/tela/infra/.env
if [[ ! -f "$ENV_FILE" ]]; then
  echo
  echo "Gere os segredos e coloque em $ENV_FILE (e no livekit.yaml):"
  echo "  LIVEKIT_API_SECRET=$(openssl rand -base64 36)"
  echo "  SIGNAL_SECRET=$(openssl rand -base64 36)"
fi

echo
echo "Docker instalado. Próximos passos:"
echo "  1. bash infra/scripts/firewall.sh"
echo "  2. abrir as MESMAS portas no firewall do provedor"
echo "  3. apontar tela.gg, www e turn.tela.gg para este IP"
echo "  4. preencher infra/.env e infra/livekit/livekit.yaml"
echo "  5. pnpm install && pnpm build"
echo "  6. docker compose -f infra/compose/docker-compose.yml up -d --build"

#!/usr/bin/env bash
# Firewall do host para o modo SFU.
#
# LEMBRE: em nuvem existem DOIS firewalls. Este (ufw) e o do provedor
# (Security Group na AWS, Network Security List na Oracle). O da Oracle é o
# esquecido com mais frequência, e o sintoma é sempre o mesmo: o signaling
# conecta, o vídeo nunca aparece.
set -euo pipefail

ufw default deny incoming
ufw default allow outgoing

ufw allow 22/tcp   comment 'ssh'
ufw allow 80/tcp   comment 'http (acme)'
ufw allow 443/tcp  comment 'https'
ufw allow 7881/tcp comment 'livekit ice-tcp fallback'
ufw allow 7882/udp comment 'livekit media'
ufw allow 3478/udp comment 'turn'
ufw allow 5349/tcp comment 'turn tls'

ufw --force enable
ufw status numbered

cat <<'TXT'

7882/udp é o que faz o produto funcionar. Se o UDP estiver bloqueado, tudo cai
para TCP na 7881, o TCP retransmite em ordem e a latência dobra ou triplica.

Valide DE FORA da máquina:
  nc -zvu <IP> 7882
TXT

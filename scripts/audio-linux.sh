#!/usr/bin/env bash
# Áudio do jogo no Linux (PipeWire ou PulseAudio).
#
# O Chrome no Linux não entrega áudio do sistema via getDisplayMedia — só
# áudio de aba. Jogo nativo sai mudo para os espectadores, e nada na interface
# do browser explica por quê.
#
# A saída é criar um sink virtual, mandar o jogo para ele, e capturar o
# monitor desse sink como se fosse um microfone. No Windows nada disso é
# necessário: lá basta marcar "compartilhar áudio" no picker do Chrome.
set -euo pipefail

command -v pactl >/dev/null || {
  echo "pactl não encontrado. Instale pulseaudio-utils (ou pipewire-pulse)." >&2
  exit 1
}

if pactl list short sinks | grep -q tela_cap; then
  echo "sink 'tela_cap' já existe"
else
  pactl load-module module-null-sink \
    sink_name=tela_cap \
    sink_properties=device.description=TelaCapture >/dev/null
  echo "sink 'TelaCapture' criado"
fi

# Espelha para o seu fone também — senão você joga surdo.
pactl load-module module-loopback \
  source=tela_cap.monitor \
  sink="$(pactl get-default-sink)" \
  latency_msec=1 >/dev/null

cat <<'TXT'

Pronto. Agora:
  1. abra o pavucontrol → aba "Reprodução"
  2. mande o processo do jogo para "TelaCapture"
  3. no Tela, clique em "procurar entradas de áudio" e escolha
     "Monitor of TelaCapture"

Para desfazer:
  pactl unload-module module-loopback
  pactl unload-module module-null-sink
TXT

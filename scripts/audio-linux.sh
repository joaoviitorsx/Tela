#!/usr/bin/env bash
# Áudio do jogo no Linux (PipeWire com pipewire-pulse, ou PulseAudio).
#
# O Chrome no Linux não entrega áudio do sistema via getDisplayMedia — só
# áudio de aba. Jogo nativo sai mudo para os espectadores. A saída é criar um
# sink virtual, mandar SÓ o jogo para ele, e capturar o monitor desse sink
# como se fosse um microfone. No Windows nada disso é necessário.
#
#   bash audio-linux.sh setup [saida]   cria o sink e o retorno para o seu fone
#   bash audio-linux.sh status          mostra o que existe e o que está errado
#   bash audio-linux.sh retarget [saida] reaponta o retorno (trocou de fone)
#   bash audio-linux.sh cleanup         remove só o que este script criou
#   bash audio-linux.sh cleanup --legado  também o que a versão antiga criou
#
# Contrato (TELA-010):
# - roda como usuário, sem sudo, e nada é permanente: reiniciar o servidor de
#   áudio desfaz tudo;
# - `setup` repetido não duplica sink nem retorno;
# - a identidade dos módulos é a MARCA nos argumentos (tela.managed=1), não o
#   número: IDs são reaproveitados depois que o servidor reinicia, e remover
#   por número apagaria o módulo de outra pessoa;
# - nunca descarrega loopbacks ou null sinks que não tenham a marca;
# - recusa ligar o retorno de volta no próprio sink (seria microfonia).
set -euo pipefail

SINK=tela_cap
DESCRICAO=TelaCapture
MARCA=tela.managed=1
# 1 ms é um número, não uma garantia: abaixo do quantum do servidor ele só
# troca estabilidade por nada. 30 ms é conservador; ajuste com TELA_LATENCIA_MS
# se ouvir atraso no seu próprio fone, ou estalos.
LATENCIA_MS="${TELA_LATENCIA_MS:-30}"

falha() {
  echo "erro: $*" >&2
  exit 1
}

preparar() {
  [[ "${EUID:-$(id -u)}" -ne 0 ]] || falha "rode como seu usuário, sem sudo: o áudio é da sua sessão."
  command -v pactl >/dev/null || falha "pactl não encontrado. Instale pulseaudio-utils (ou pipewire-pulse)."
  pactl info >/dev/null 2>&1 || falha "servidor de áudio não respondeu. PipeWire/PulseAudio está rodando?"
  [[ "$LATENCIA_MS" =~ ^[0-9]{1,4}$ ]] || falha "TELA_LATENCIA_MS precisa ser um número de milissegundos."
}

servidor() {
  pactl info | sed -n 's/^Server Name: //p'
}

# "ID nome argumentos" dos módulos com a marca, e só deles.
nossos() {
  pactl list short modules | awk -v tipo="$1" -v marca="$MARCA" \
    '$2 == tipo && index($0, marca) > 0 { print $1 }'
}

# A versão anterior não marcava nada. Reconhecida pelos argumentos exatos que
# ela usava — nunca por "qualquer loopback" ou "qualquer null sink".
legados() {
  pactl list short modules | awk -v s="$SINK" -v marca="$MARCA" '
    index($0, marca) > 0 { next }
    $2 == "module-loopback" && index($0, "source=" s ".monitor") > 0 { print $1; next }
    $2 == "module-null-sink" && index($0, "sink_name=" s) > 0 { print $1 }'
}

sink_existe() {
  pactl list short sinks | awk -v s="$SINK" '$2 == s { achou = 1 } END { exit !achou }'
}

# Uma saída física válida: a escolhida, a padrão, ou a primeira que não é nossa.
saida_para() {
  local pedida="${1:-}"
  local lista
  lista="$(pactl list short sinks | awk '{ print $2 }')"
  if [[ -n "$pedida" ]]; then
    [[ "$pedida" != "$SINK" ]] || falha "o retorno não pode apontar para o próprio $SINK (microfonia)."
    grep -qxF -- "$pedida" <<<"$lista" || falha "saída '$pedida' não existe. Veja: pactl list short sinks"
    echo "$pedida"
    return
  fi
  local padrao
  padrao="$(pactl get-default-sink 2>/dev/null || true)"
  if [[ -n "$padrao" && "$padrao" != "$SINK" ]]; then
    echo "$padrao"
    return
  fi
  local outra
  outra="$(grep -vxF -- "$SINK" <<<"$lista" | head -n 1 || true)"
  [[ -n "$outra" ]] || falha "nenhuma saída física encontrada para o retorno."
  echo "$outra"
}

criar_retorno() {
  local saida="$1"
  pactl load-module module-loopback \
    source="$SINK.monitor" \
    sink="$saida" \
    latency_msec="$LATENCIA_MS" \
    channels=2 channel_map=front-left,front-right \
    "sink_input_properties=\"media.name=TelaRetorno $MARCA\"" \
    "source_output_properties=\"media.name=TelaRetorno $MARCA\"" >/dev/null
}

setup() {
  preparar
  if [[ -n "$(nossos module-null-sink)" ]]; then
    echo "sink '$DESCRICAO' já existe — nada criado"
  elif [[ -n "$(legados)" ]]; then
    falha "há módulos da versão antiga deste script. Rode 'cleanup --legado' e depois 'setup'."
  elif sink_existe; then
    falha "já existe um sink '$SINK' que não foi criado por este script. Remova-o ou renomeie antes."
  else
    pactl load-module module-null-sink \
      sink_name="$SINK" \
      rate=48000 channels=2 channel_map=front-left,front-right \
      "sink_properties=\"device.description=$DESCRICAO $MARCA\"" >/dev/null
    echo "sink '$DESCRICAO' criado (estéreo, 48 kHz)"
  fi

  if [[ -n "$(nossos module-loopback)" ]]; then
    echo "retorno para o fone já existe — nada criado (use 'retarget' para trocar a saída)"
  else
    local saida
    saida="$(saida_para "${1:-}")"
    criar_retorno "$saida"
    echo "retorno criado: $DESCRICAO → $saida (${LATENCIA_MS} ms)"
  fi

  verificar_canais
  cat <<TXT

Pronto. Agora:
  1. abra o pavucontrol → aba "Reprodução"
  2. mande SÓ o processo do jogo para "$DESCRICAO"
     (a chamada de voz fica onde está — senão seus amigos se ouvem de volta)
  3. no Tela, procure as entradas de áudio e escolha "Monitor of $DESCRICAO"

Para desfazer: bash $(basename "$0") cleanup
TXT
}

verificar_canais() {
  local spec
  spec="$(pactl list short sinks | awk -v s="$SINK" '$2 == s { print $4, $5, $6 }')"
  if [[ -n "$spec" && "$spec" != *"2ch"* ]]; then
    echo "aviso: $SINK não está em estéreo ($spec). O som chega mono." >&2
  fi
}

retarget() {
  preparar
  [[ -n "$(nossos module-null-sink)" ]] || falha "não há sink do Tela. Rode 'setup' primeiro."
  local saida
  saida="$(saida_para "${1:-}")"
  local id
  for id in $(nossos module-loopback); do
    pactl unload-module "$id"
  done
  criar_retorno "$saida"
  echo "retorno reapontado: $DESCRICAO → $saida"
}

cleanup() {
  preparar
  local id removidos=0 alvo
  # Loopback antes do sink: tirar o sink primeiro deixaria o retorno órfão.
  alvo="$(nossos module-loopback) $(nossos module-null-sink)"
  [[ "${1:-}" != "--legado" ]] || alvo="$alvo $(legados)"
  for id in $alvo; do
    pactl unload-module "$id"
    removidos=$((removidos + 1))
  done
  echo "removidos: $removidos módulo(s) do Tela. Módulos de outros programas não foram tocados."
}

status() {
  preparar
  echo "servidor: $(servidor)"
  local sinks retornos
  sinks="$(nossos module-null-sink | wc -l | tr -d ' ')"
  retornos="$(nossos module-loopback | wc -l | tr -d ' ')"
  echo "sink do Tela: $sinks   retorno para o fone: $retornos"
  [[ "$sinks" -le 1 && "$retornos" -le 1 ]] || echo "aviso: há duplicados. Rode 'cleanup' e depois 'setup'." >&2
  [[ -z "$(legados)" ]] || echo "aviso: há módulos da versão antiga. Rode 'cleanup --legado'." >&2
  if [[ "$(pactl get-default-sink 2>/dev/null || true)" == "$SINK" ]]; then
    echo "aviso: $DESCRICAO é a saída PADRÃO. Tudo vai para a transmissão — inclusive a chamada de voz." >&2
  fi
  verificar_canais
}

case "${1:-}" in
  setup) shift; setup "$@" ;;
  status) status ;;
  retarget) shift; retarget "$@" ;;
  cleanup) shift; cleanup "$@" ;;
  *)
    sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
    [[ -z "${1:-}" || "${1:-}" == "-h" || "${1:-}" == "--help" ]] || exit 2
    ;;
esac

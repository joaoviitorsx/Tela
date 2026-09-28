#!/usr/bin/env bash
# Teste de `audio-linux.sh` contra um `pactl` FALSO (TELA-010).
#
# O falso guarda módulos e sinks em arquivos e reproduz o que importa: IDs
# crescentes, argumentos visíveis em `list short modules`, e reinício do
# servidor que apaga tudo e RECOMEÇA a numeração — o caso em que remover por
# ID apagaria o módulo de outro programa.
#
# Não prova o comportamento do PipeWire real. Isso fica para o roteiro manual
# em docs/qa/TELA-010-audio-linux.md.
set -euo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$AQUI/audio-linux.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export FAKE_PACTL_DIR="$TMP/estado"
mkdir -p "$TMP/bin" "$FAKE_PACTL_DIR"

cat >"$TMP/bin/pactl" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
D="$FAKE_PACTL_DIR"
touch "$D/modules" "$D/sinks"
[[ -f "$D/next" ]] || echo 1 >"$D/next"
[[ -f "$D/default" ]] || echo fone >"$D/default"
grep -q '^fone$' "$D/sinks" || echo fone >>"$D/sinks"
case "$1 ${2:-}" in
  "info "*) echo "Server Name: PulseAudio (on PipeWire 1.2.0)"; echo "Default Sink: $(cat "$D/default")" ;;
  "get-default-sink "*) cat "$D/default" ;;
  "list short")
    case "$3" in
      modules) cat "$D/modules" ;;
      sinks) awk '{ printf "%d\t%s\tPipeWire\tfloat32le 2ch 48000Hz\tSUSPENDED\n", NR, $1 }' "$D/sinks" ;;
    esac ;;
  "load-module "*)
    id="$(cat "$D/next")"; echo $((id + 1)) >"$D/next"
    modulo="$2"
    shift 2
    printf '%s\t%s\t%s\n' "$id" "$modulo" "$*" >>"$D/modules"
    if [[ "$modulo" == module-null-sink ]]; then
      for a in "$@"; do [[ "$a" == sink_name=* ]] && echo "${a#sink_name=}" >>"$D/sinks"; done
    fi
    echo "$id" ;;
  "unload-module "*)
    linha="$(awk -v id="$2" '$1 == id' "$D/modules")"
    [[ -n "$linha" ]] || { echo "Failure: No such entity" >&2; exit 1; }
    awk -v id="$2" '$1 != id' "$D/modules" >"$D/m.tmp"; mv "$D/m.tmp" "$D/modules"
    if [[ "$linha" == *module-null-sink* ]]; then
      nome="$(grep -o 'sink_name=[^ ]*' <<<"$linha" | head -n1 | cut -d= -f2)"
      grep -vxF "$nome" "$D/sinks" >"$D/s.tmp" || true; mv "$D/s.tmp" "$D/sinks"
    fi ;;
  *) echo "pactl falso: comando não simulado: $*" >&2; exit 1 ;;
esac
FAKE
chmod +x "$TMP/bin/pactl"
export PATH="$TMP/bin:$PATH"

falhas=0
confere() {
  if [[ "$1" == "$2" ]]; then echo "  ok    $3"; else echo " FALHA $3 (esperado '$2', veio '$1')"; falhas=$((falhas + 1)); fi
}
# Afirma que o padrão aparece no arquivo. `grep && confere` sozinho engolia a falha.
tem() {
  if grep -q -- "$1" "$2"; then confere sim sim "$3"; else confere nao sim "$3"; fi
}
contar() { awk -v t="$1" '$2 == t' "$FAKE_PACTL_DIR/modules" | wc -l | tr -d ' '; }
reiniciar_servidor() { : >"$FAKE_PACTL_DIR/modules"; echo fone >"$FAKE_PACTL_DIR/sinks"; echo 1 >"$FAKE_PACTL_DIR/next"; }
terceiro() { pactl load-module "$@" >/dev/null; }

echo "setup dez vezes não duplica nada"
for _ in $(seq 1 10); do bash "$SCRIPT" setup >/dev/null; done
confere "$(contar module-null-sink)" 1 "um sink"
confere "$(contar module-loopback)" 1 "um retorno"
tem 'sink=fone' "$FAKE_PACTL_DIR/modules" "retorno aponta para a saída padrão"

echo "cleanup preserva módulos de terceiros"
terceiro module-loopback source=mic sink=fone
terceiro module-null-sink sink_name=obs_sink
bash "$SCRIPT" cleanup >/dev/null
confere "$(contar module-loopback)" 1 "loopback de terceiro intacto"
confere "$(contar module-null-sink)" 1 "null sink de terceiro intacto"
tem obs_sink "$FAKE_PACTL_DIR/modules" "é o obs_sink que ficou"

echo "ID reaproveitado depois de reiniciar o servidor não é removido"
reiniciar_servidor
bash "$SCRIPT" setup >/dev/null                      # ganha IDs 1 e 2
reiniciar_servidor
terceiro module-loopback source=mic sink=fone         # terceiro ganha o ID 1
terceiro module-null-sink sink_name=obs_sink          # e o 2
bash "$SCRIPT" cleanup >/dev/null
confere "$(wc -l <"$FAKE_PACTL_DIR/modules" | tr -d ' ')" 2 "os dois módulos de terceiros sobrevivem"

echo "retorno nunca aponta para o próprio sink"
reiniciar_servidor
bash "$SCRIPT" setup >/dev/null
if bash "$SCRIPT" retarget tela_cap >/dev/null 2>&1; then r=aceitou; else r=recusou; fi
confere "$r" recusou "retarget para tela_cap é recusado"
echo tela_cap >"$FAKE_PACTL_DIR/default"
bash "$SCRIPT" cleanup >/dev/null
bash "$SCRIPT" setup >/dev/null
if grep 'module-loopback' "$FAKE_PACTL_DIR/modules" | grep -q 'sink=tela_cap'; then r=microfonia; else r=ok; fi
confere "$r" ok "com tela_cap como padrão, o retorno vai para uma saída física"
echo fone >"$FAKE_PACTL_DIR/default"

echo "retarget troca a saída sem duplicar"
echo headset >>"$FAKE_PACTL_DIR/sinks"
bash "$SCRIPT" retarget headset >/dev/null
confere "$(contar module-loopback)" 1 "ainda um retorno"
tem 'sink=headset' "$FAKE_PACTL_DIR/modules" "retorno aponta para headset"

echo "versão antiga é reconhecida e migrada só com --legado"
reiniciar_servidor
terceiro module-null-sink sink_name=tela_cap sink_properties=device.description=TelaCapture
terceiro module-loopback source=tela_cap.monitor sink=fone latency_msec=1
terceiro module-loopback source=mic sink=fone
if bash "$SCRIPT" setup >/dev/null 2>&1; then r=seguiu; else r=parou; fi
confere "$r" parou "setup para diante de módulos antigos"
bash "$SCRIPT" cleanup >/dev/null
confere "$(wc -l <"$FAKE_PACTL_DIR/modules" | tr -d ' ')" 3 "cleanup simples não toca os antigos"
bash "$SCRIPT" cleanup --legado >/dev/null
confere "$(wc -l <"$FAKE_PACTL_DIR/modules" | tr -d ' ')" 1 "--legado remove só os dois antigos"
tem 'source=mic' "$FAKE_PACTL_DIR/modules" "o loopback do microfone ficou"

echo "status aponta duplicados e saída padrão errada"
reiniciar_servidor
bash "$SCRIPT" setup >/dev/null
echo tela_cap >"$FAKE_PACTL_DIR/default"
aviso="$(bash "$SCRIPT" status 2>&1 >/dev/null || true)"
if [[ "$aviso" == *"saída PADRÃO"* ]]; then r=avisou; else r=calou; fi
confere "$r" avisou "avisa que a chamada de voz entraria na transmissão"

[[ "$falhas" -eq 0 ]] && echo "=== audio-linux: PASSOU ===" || { echo "=== audio-linux: $falhas FALHA(S) ==="; exit 1; }

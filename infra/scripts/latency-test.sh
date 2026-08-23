#!/usr/bin/env bash
# Prepara a medição de latência glass-to-glass.
#
# RTCStats mede rede, não experiência. O número que importa é do pixel na sua
# tela ao pixel na tela do amigo, e só uma câmera a 240fps mede isso.
# Este script só serve o cronômetro; a medição é humana.
set -euo pipefail

PORT="${1:-8099}"
DIR="$(mktemp -d)"

cat > "$DIR/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8" />
<title>cronômetro</title>
<style>
  body { background:#000; color:#0f0; display:grid; place-items:center; height:100vh; margin:0 }
  b { font:900 14vw ui-monospace, monospace; font-variant-numeric: tabular-nums }
</style>
<b id="t">0.000</b>
<script>
  const el = document.getElementById('t');
  const start = performance.now();
  function tick() {
    el.textContent = ((performance.now() - start) / 1000).toFixed(3);
    requestAnimationFrame(tick);
  }
  tick();
</script>
HTML

cat <<TXT
Cronômetro em http://localhost:$PORT

  1. transmita a aba do cronômetro
  2. ponha os dois monitores lado a lado (transmissor e espectador)
  3. filme os dois com um celular a 240fps
  4. avance quadro a quadro e subtraia os valores lidos
  5. repita 10 vezes e use a MEDIANA, não a média

Esperado: 110–190ms na mesma cidade; 150–250ms Fortaleza↔SP.
Acima de 350ms: pare e resolva a infra antes de escrever produto.

Ctrl+C para encerrar.
TXT

cd "$DIR" && python3 -m http.server "$PORT"

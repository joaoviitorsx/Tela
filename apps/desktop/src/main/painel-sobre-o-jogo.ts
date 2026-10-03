/**
 * O painel sobre o jogo: uma faixa pequena, transparente e sempre no topo,
 * com "● AO VIVO 12:34 · 3 assistindo" — quem joga não precisa de Alt+Tab
 * para saber se os amigos entraram ou se a transmissão caiu.
 *
 * Puro: posição, texto e o HTML. Quem cria a janela é o main, e ela é
 * ATRAVESSÁVEL (`setIgnoreMouseEvents`) e sem foco: nunca rouba clique nem
 * teclado do jogo. Só existe com a transmissão no ar e o ajuste ligado —
 * fora disso o processo dela nem existe.
 *
 * Custo: uma página estática sem framework, atualizada uma vez por segundo
 * pelo main. Jogo em tela cheia EXCLUSIVA não deixa nada por cima (limite do
 * sistema); em tela cheia sem bordas, aparece.
 */
import type { EstadoAoVivo } from './estado-ao-vivo.js';

export type CantoDoPainel = 'sup-dir' | 'sup-esq' | 'inf-dir' | 'inf-esq';

export const CANTOS_DO_PAINEL: readonly CantoDoPainel[] = ['sup-dir', 'sup-esq', 'inf-dir', 'inf-esq'];

export const TAMANHO_DO_PAINEL = { largura: 300, altura: 40 } as const;

const MARGEM = 16;

type Retangulo = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };

/** Onde a faixa fica, dentro da área útil da tela (sem a barra de tarefas). */
export function posicaoDoPainel(area: Retangulo, canto: CantoDoPainel): { readonly x: number; readonly y: number } {
  const direita = canto.endsWith('dir');
  const embaixo = canto.startsWith('inf');
  return {
    x: Math.round(direita ? area.x + area.width - TAMANHO_DO_PAINEL.largura - MARGEM : area.x + MARGEM),
    y: Math.round(embaixo ? area.y + area.height - TAMANHO_DO_PAINEL.altura - MARGEM : area.y + MARGEM),
  };
}

export type TextoDoPainel = { readonly tempo: string; readonly assistindo: number; readonly oculto: boolean };

function doisDigitos(n: number): string {
  return n.toString().padStart(2, '0');
}

/** `null` fora do ar: o painel não tem o que mostrar e a janela fecha. */
export function textoDoPainel(estado: EstadoAoVivo, agoraMs: number): TextoDoPainel | null {
  if (!estado.noAr || estado.inicioMs === null) return null;
  const s = Math.max(0, Math.floor((agoraMs - estado.inicioMs) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const tempo = h > 0 ? `${h}:${doisDigitos(m)}:${doisDigitos(s % 60)}` : `${doisDigitos(m)}:${doisDigitos(s % 60)}`;
  return { tempo, assistindo: estado.assistindo, oculto: estado.oculto };
}

/**
 * O que o main executa na página a cada segundo. Os dados passam por
 * `JSON.stringify` de três campos já validados (tempo formatado, inteiro,
 * booleano): nada de texto vindo de fora vira código.
 */
export function chamadaDeAtualizacao(t: TextoDoPainel): string {
  return `atualizar(${JSON.stringify({ tempo: t.tempo, assistindo: t.assistindo, oculto: t.oculto })})`;
}

/**
 * A página inteira, inline: carregada como `data:` sem rede, sem fonte
 * externa e com CSP que só permite o próprio script e estilo.
 */
export const HTML_DO_PAINEL = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;cursor:default}
#f{box-sizing:border-box;height:100%;display:flex;align-items:center;gap:8px;padding:0 12px;
background:rgba(10,10,12,.82);border:2px solid #3a3d46;color:#e8e2d6;
font:700 12px/1 ui-monospace,"Cascadia Mono","DejaVu Sans Mono",monospace;letter-spacing:.04em;white-space:nowrap}
#l{width:9px;height:9px;background:#ef4f3b;flex:none;animation:p 1.6s steps(1) infinite}
#r{color:#ff6a55}#t{color:#f2a93b}#a{color:#e8e2d6}
#f.o{border-color:#ef4f3b}#f.o #r{color:#ffd23f}
@keyframes p{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){#l{animation:none}}
</style></head>
<body><div id="f" role="status"><span id="l"></span><span id="r">AO VIVO</span><span id="t">00:00</span><span id="a"></span></div>
<script>
function atualizar(d){
var f=document.getElementById('f');
f.className=d.oculto?'o':'';
document.getElementById('r').textContent=d.oculto?'OCULTO':'AO VIVO';
document.getElementById('t').textContent=d.tempo;
document.getElementById('a').textContent='· '+d.assistindo+' assistindo';
}
</script></body></html>`;

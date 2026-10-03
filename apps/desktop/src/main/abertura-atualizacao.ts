/**
 * A abertura do app com atualização, no estilo da Discord: antes da janela
 * principal aparecer, uma janelinha procura versão nova; se houver, baixa,
 * instala e o app reabre já atualizado. Se não houver — ou sem rede, ou
 * demorando — o Tela abre como sempre.
 *
 * Tudo aqui é puro (sem Electron): o motor e o relógio entram por
 * dependência, e o teste roda com motor falso (`abertura-atualizacao.test.ts`).
 * O main só cria a janela e liga `aoMudar` ao texto dela.
 *
 * Nada aqui prende a pessoa: a verificação tem prazo, erro vira "abrir", e
 * durante o download há ABRIR SEM ATUALIZAR — a atualização continua depois,
 * pelo caminho de sempre (`atualizador.ts`, em segundo plano, instala ao sair).
 */
import type { ModoDeAtualizacao } from './atualizacao-release.js';
import type { MotorDeAtualizacao } from './atualizador.js';

export type FaseDaAbertura =
  | { readonly tipo: 'procurando' }
  | { readonly tipo: 'baixando'; readonly percentual: number; readonly versao: string }
  | { readonly tipo: 'instalando'; readonly versao: string };

/** `abrir`: segue para a janela principal. `instalando`: o app vai fechar e reabrir atualizado. */
export type DesfechoDaAbertura = 'abrir' | 'instalando';

/** Quanto a pessoa espera, no máximo, pela resposta de "há versão nova?". */
export const PRAZO_DA_VERIFICACAO_MS = 5_000;

/**
 * A abertura só aparece quando ela pode CUMPRIR o que promete: atualização
 * automática (Windows e AppImage), com o ajuste ligado, e o app aberto por
 * alguém — o autostart abre escondido na bandeja, e uma janela piscando no
 * login do sistema seria intrusiva. Em deb/rpm não há o que instalar daqui.
 */
export function deveMostrarAbertura(p: {
  readonly modo: ModoDeAtualizacao;
  readonly automatico: boolean;
  readonly oculto: boolean;
}): boolean {
  return p.modo === 'automatica' && p.automatico && !p.oculto;
}

export type DependenciasDaAbertura = {
  readonly motor: MotorDeAtualizacao;
  readonly aoMudar: (fase: FaseDaAbertura) => void;
  /** Agenda `fn` e devolve o cancelamento. */
  readonly agendar: (fn: () => void, ms: number) => () => void;
  /** Resolve quando a pessoa clica em ABRIR SEM ATUALIZAR. */
  readonly pulou: Promise<void>;
  readonly log: { readonly info: (m: string) => void; readonly erro: (m: string, e?: unknown) => void };
  readonly prazoDaVerificacaoMs?: number;
};

const PULOU: unique symbol = Symbol('pulou');
const ESGOTOU: unique symbol = Symbol('esgotou');

export async function executarAbertura(deps: DependenciasDaAbertura): Promise<DesfechoDaAbertura> {
  const { motor, log } = deps;
  deps.aoMudar({ tipo: 'procurando' });

  let cancelarPrazo: () => void = () => undefined;
  const prazo = new Promise<typeof ESGOTOU>((r) => {
    cancelarPrazo = deps.agendar(() => r(ESGOTOU), deps.prazoDaVerificacaoMs ?? PRAZO_DA_VERIFICACAO_MS);
  });
  const pulou = deps.pulou.then((): typeof PULOU => PULOU);

  let achou: Awaited<ReturnType<MotorDeAtualizacao['verificar']>> | typeof ESGOTOU | typeof PULOU;
  try {
    achou = await Promise.race([motor.verificar(), prazo, pulou]);
  } catch (erro: unknown) {
    log.erro('abertura: verificação falhou; abrindo sem atualizar', erro);
    return 'abrir';
  } finally {
    cancelarPrazo();
  }
  if (achou === ESGOTOU) {
    log.info('abertura: verificação passou do prazo; abrindo (o atualizador tenta depois)');
    return 'abrir';
  }
  if (achou === PULOU || achou === null) return 'abrir';

  const { versao } = achou;
  log.info(`abertura: baixando ${versao}`);
  deps.aoMudar({ tipo: 'baixando', percentual: 0, versao });
  let baixada: string | null | typeof PULOU;
  try {
    baixada = await Promise.race([
      motor.baixar((percentual) => deps.aoMudar({ tipo: 'baixando', percentual: limitar(percentual), versao })),
      pulou,
    ]);
  } catch (erro: unknown) {
    log.erro('abertura: download falhou; abrindo sem atualizar', erro);
    return 'abrir';
  }
  if (baixada === PULOU) {
    // O atualizador recomeça em segundo plano (com o blockmap, só o que falta).
    motor.cancelarDownload();
    return 'abrir';
  }
  if (baixada === null) return 'abrir';

  deps.aoMudar({ tipo: 'instalando', versao });
  try {
    motor.instalarAgora();
  } catch (erro: unknown) {
    log.erro('abertura: não deu para instalar; abrindo sem atualizar', erro);
    return 'abrir';
  }
  return 'instalando';
}

function limitar(p: number): number {
  return Number.isFinite(p) ? Math.min(100, Math.max(0, Math.round(p))) : 0;
}

/** O que a página mostra em cada fase. `JSON.stringify` na chamada: nada de fora vira código. */
export type TextoDaFase = {
  readonly tipo: FaseDaAbertura['tipo'];
  readonly linha: string;
  readonly progresso: number | null;
  readonly podePular: boolean;
};

export function textoDaFase(fase: FaseDaAbertura): TextoDaFase {
  switch (fase.tipo) {
    case 'procurando':
      return { tipo: fase.tipo, linha: 'Procurando atualização…', progresso: null, podePular: false };
    case 'baixando':
      return {
        tipo: fase.tipo,
        linha: `Baixando a versão ${fase.versao} — ${fase.percentual}%`,
        progresso: fase.percentual,
        podePular: true,
      };
    case 'instalando':
      return { tipo: fase.tipo, linha: 'Instalando. O Tela abre de novo sozinho.', progresso: 100, podePular: false };
  }
}

export function chamadaDaFase(fase: FaseDaAbertura): string {
  return `fase(${JSON.stringify(textoDaFase(fase))})`;
}

/**
 * O título que a página põe ao clicar em "Abrir sem atualizar": a página é
 * `data:` sem preload (sem IPC), e o main escuta `page-title-updated`.
 */
export const TITULO_DE_PULAR = 'tela:pular';

/** Blocos da barra: 20 de 5% — a barra acende bloco a bloco, como fósforo de CRT. */
const BLOCOS = 20;

/**
 * A página inteira, inline: `data:` sem rede e CSP fechada.
 *
 * O mascote é a própria logo — a TV inclinada que pisca — em SVG, e cada fase
 * tem UM gesto dele, só com `transform` e `opacity` (compositor, sem layout):
 *  - procurando: as antenas balançam caçando sinal e os olhos varrem a sala;
 *  - baixando: os olhos descem para a barra, o LED pisca rápido, e a barra
 *    acende bloco a bloco;
 *  - instalando: a piscadinha da logo e o tubo desligando numa linha, como
 *    um CRT — o app fecha e volta já atualizado.
 * Com `prefers-reduced-motion`, a TV fica parada e só a barra e o texto mudam.
 */
export const HTML_DA_ABERTURA = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>Tela</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<style>
:root{--fundo:#100d09;--ambar:#f2a93b;--amarelo:#ffd23f;--texto:#efe6d4;--suave:#a89c86;--corpo:#a4a7b1;--aro:#1c1d22;--tela:#17181c}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--fundo);color:var(--texto);overflow:hidden;user-select:none;-webkit-app-region:drag;
font:500 13px/1.45 ui-rounded,"SF Pro Rounded","Segoe UI Variable Display","Segoe UI",system-ui,sans-serif}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;padding:24px;
background:radial-gradient(120% 70% at 50% 34%,rgba(242,169,59,.16),transparent 62%),var(--fundo)}
body:after{content:"";position:fixed;inset:0;pointer-events:none;background:repeating-linear-gradient(0deg,rgba(0,0,0,.18) 0 1px,transparent 1px 3px)}
#tv{width:176px;height:156px;overflow:visible;animation:flutua 2.6s ease-in-out infinite}
#corpo{transform-origin:100px 100px;transform:rotate(-7deg)}
.antena{transform-box:fill-box;transform-origin:50% 100%}
#a1{animation:caca 1.3s ease-in-out infinite}
#a2{animation:caca 1.3s ease-in-out infinite reverse}
.ponta{animation:pisca 1.3s steps(1) infinite}
#p2{animation-delay:.65s}
#olhos{animation:varre 2.2s ease-in-out infinite}
#led{animation:led 1.6s steps(1) infinite}
#piscada,#linha{opacity:0}
#face{transform-box:fill-box;transform-origin:50% 50%}
#l{min-height:19px;text-align:center;color:var(--texto);letter-spacing:.01em}
#b{display:flex;gap:3px;padding:3px;border:2px solid #3a3326;background:#000;opacity:0;transition:opacity .25s ease-out}
.k{width:8px;height:10px;background:var(--ambar);opacity:.12;transition:opacity .18s ease-out,box-shadow .18s ease-out}
.k.on{opacity:1;box-shadow:0 0 6px rgba(242,169,59,.75)}
#s{-webkit-app-region:no-drag;visibility:hidden;min-height:34px;padding:0 14px;border:2px solid #3a3326;border-radius:6px;
background:#1b1610;color:var(--suave);font:inherit;cursor:pointer;transition:border-color .15s ease-out,color .15s ease-out}
#s:hover{border-color:var(--ambar);color:var(--texto)}
#s:focus-visible{outline:2px solid var(--amarelo);outline-offset:2px;color:var(--texto)}
body[data-fase="baixando"] #b,body[data-fase="instalando"] #b{opacity:1}
body[data-fase="baixando"] #olhos{animation:none;transform:translate(0,4px)}
body[data-fase="baixando"] #led{animation-duration:.5s}
body[data-fase="baixando"] .antena{animation-duration:2.6s}
body[data-fase="instalando"] #tv{animation:none}
body[data-fase="instalando"] .antena,body[data-fase="instalando"] .ponta,body[data-fase="instalando"] #olhos{animation:none}
body[data-fase="instalando"] #olhoD{opacity:0}
body[data-fase="instalando"] #piscada{opacity:1}
body[data-fase="instalando"] #face{animation:desliga .7s 1.1s ease-in forwards}
body[data-fase="instalando"] #linha{animation:linha .9s 1.1s ease-out forwards}
@keyframes flutua{50%{transform:translateY(-5px)}}
@keyframes caca{0%,100%{transform:rotate(-9deg)}50%{transform:rotate(9deg)}}
@keyframes pisca{50%{opacity:.35}}
@keyframes varre{0%,100%{transform:translateX(-7px)}45%,55%{transform:translateX(7px)}}
@keyframes led{50%{opacity:.25}}
@keyframes desliga{60%{transform:scale(1,.04)}100%{transform:scale(0,.04);opacity:0}}
@keyframes linha{0%{opacity:0}35%{opacity:1}100%{opacity:0}}
@media (prefers-reduced-motion:reduce){#tv,.antena,.ponta,#olhos,#led{animation:none!important}
body[data-fase="instalando"] #face,body[data-fase="instalando"] #linha{animation:none}.k{transition:none}}
</style></head>
<body data-fase="procurando">
<svg id="tv" viewBox="0 0 200 180" aria-hidden="true">
 <g id="corpo">
  <g id="a1" class="antena"><path d="M78 62 L54 20" stroke="var(--aro)" stroke-width="6" stroke-linecap="round"/><circle id="p1" class="ponta" cx="52" cy="16" r="9" fill="#ef6a57" stroke="var(--aro)" stroke-width="5"/></g>
  <g id="a2" class="antena"><path d="M122 60 L144 18" stroke="var(--aro)" stroke-width="6" stroke-linecap="round"/><circle id="p2" class="ponta" cx="147" cy="13" r="9" fill="#ef6a57" stroke="var(--aro)" stroke-width="5"/></g>
  <rect x="18" y="58" width="164" height="108" rx="26" fill="var(--corpo)" stroke="var(--aro)" stroke-width="6"/>
  <rect x="30" y="64" width="60" height="7" rx="3.5" fill="#cfd2da"/>
  <rect x="134" y="70" width="34" height="86" rx="10" fill="#7d818d"/>
  <rect id="led" x="142" y="80" width="18" height="9" rx="3" fill="#3ad46a" stroke="var(--aro)" stroke-width="3"/>
  <circle cx="151" cy="108" r="8" fill="#3b3e48"/>
  <circle cx="151" cy="138" r="5" fill="#ef6a57"/>
  <rect x="30" y="74" width="98" height="80" rx="18" fill="#5d616c"/>
  <g id="face">
   <rect x="38" y="81" width="82" height="66" rx="14" fill="var(--tela)"/>
   <g id="olhos">
    <rect x="58" y="98" width="9" height="15" rx="4.5" fill="var(--ambar)"/>
    <rect id="olhoD" x="92" y="98" width="9" height="15" rx="4.5" fill="var(--ambar)"/>
   </g>
   <path id="piscada" d="M89 108 q7 -9 14 0" fill="none" stroke="var(--ambar)" stroke-width="5" stroke-linecap="round"/>
   <circle cx="54" cy="125" r="5" fill="#8e4636" opacity=".85"/><circle cx="106" cy="125" r="5" fill="#8e4636" opacity=".85"/>
   <path d="M66 124 q13 13 26 0" fill="none" stroke="var(--ambar)" stroke-width="5" stroke-linecap="round"/>
  </g>
  <rect id="linha" x="40" y="112" width="78" height="3" rx="1.5" fill="var(--amarelo)"/>
 </g>
</svg>
<div id="l" role="status" aria-live="polite">Procurando atualização…</div>
<div id="b" aria-hidden="true">${'<i class="k"></i>'.repeat(BLOCOS)}</div>
<button id="s" type="button">Abrir sem atualizar</button>
<script>
var blocos=document.querySelectorAll('.k');
function fase(d){
document.body.setAttribute('data-fase',d.tipo);
document.getElementById('l').textContent=d.linha;
var n=d.progresso===null?0:Math.round(d.progresso/(100/blocos.length));
for(var i=0;i<blocos.length;i++)blocos[i].classList.toggle('on',i<n);
document.getElementById('s').style.visibility=d.podePular?'visible':'hidden';
}
document.getElementById('s').addEventListener('click',function(){document.title=${JSON.stringify(TITULO_DE_PULAR)};});
</script></body></html>`;

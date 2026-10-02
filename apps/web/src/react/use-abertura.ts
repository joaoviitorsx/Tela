import { useEffect, useRef, useState } from 'react';
import {
  DURACAO_ABERTURA,
  DURACAO_FADE,
  DURACAO_HANDOFF,
  quadroReduzido,
  sampleIntro,
} from '../core/intro/timeline.js';
import { PRAZO_MODELO_MS, aguentaCoreografia, decideModoAbertura } from '../core/intro/probe.js';
import type { PalcoAbertura, PlacaDaTela } from '../core/ports/intro-stage.js';
import { aberturaPermitida, aberturaVista, abrirPalcoAbertura, suporteDeAbertura } from '../container.js';

/**
 * A abertura, do primeiro quadro ao canvas removido.
 *
 * A máquina de estados é a da §2 da coreografia, menos o passo 1: a abertura
 * roda em TODA visita à tela inicial, não uma vez por navegador (ADR 0013).
 *
 * O que segura o custo disso já estava no desenho da especificação: o DOM real
 * fica montado, opaco e interativo por baixo do canvas desde `t = 0` (§7), e
 * qualquer toque, tecla ou rolagem pula direto para o fim (§8). Quem já viu a
 * cena não espera 1,80 s — espera o tempo de encostar na tela.
 *
 * ```
 *   canvas de pé ──→ coreografia 1,80s ──→ crossfade ──→ canvas removido
 *          │                  └── skip ────────┘
 *          └── sondagem reprovou · modelo não chegou ──→ canvas removido
 * ```
 *
 * O canvas fica em `z-index` acima do DOM com `pointer-events: none`, e o DOM
 * embaixo está montado, interativo e opaco desde `t = 0` (§7). Duas
 * consequências que valem saber: a página é utilizável mesmo se a abertura
 * travar, e o clique que pula a abertura ATRAVESSA — daí o escudo.
 */
/** Escudo do §7: 250 ms em que o primeiro toque SÓ pula. */
const ESCUDO_MS = 250;

/** Primeiro quadro da coreografia. Ver a nota em `entregaAoDom`. */
const MARCA_INICIO = 'tela:abertura:inicio';

const GATILHOS_DE_SKIP = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;

/**
 * O parâmetro `?abertura`, que existe para tornar a coreografia verificável.
 *
 * | valor | efeito |
 * |---|---|
 * | `1` | roda ignorando o corte do quadro de aquecimento |
 * | `0` | pula |
 * | `t1.35` | congela em `t = 1,35 s` e não entrega ao DOM |
 * | ausente | comportamento normal — a coreografia roda |
 *
 * O `1` ignorar o corte do quadro de aquecimento é o que torna a cena visível
 * num navegador headless, onde o rasterizador é software e o quadro zero custa
 * 58 ms — reprovaria com razão, se fosse gente.
 *
 * O `t` existe porque os critérios de aceite da §13 são sobre INSTANTES —
 * "k1 ≤ 0,01 em t = 1,80", "linha horizontal antes da vertical" — e tirar foto
 * de uma animação de 1,8 s pelo relógio de parede não prova nada: capturar a
 * tela rouba quadros do `requestAnimationFrame` e o que sai não é o instante
 * pedido. Congelando o quadro, a foto é o instante.
 */
type Forcada = { readonly roda: boolean; readonly congeladaEm: number | null };

function forcada(): Forcada | null {
  const valor = new URLSearchParams(window.location.search).get('abertura');
  if (valor === null) return null;
  const congelada = /^t(\d+(?:\.\d+)?)$/.exec(valor);
  if (congelada !== null) return { roda: true, congeladaEm: Number(congelada[1]) };
  return { roda: valor !== '0', congeladaEm: null };
}

function nascePintando(): boolean {
  return forcada()?.roda ?? true;
}

/**
 * As caixas da home, medidas no DOM vivo.
 *
 * É o que o tubo mostra na L3. Cada elemento com `data-vidro` vira um
 * retângulo, e o valor do atributo diz como pintar. A nota longa sobre por que
 * isto e não um instantâneo está em `adapters/three-crt-stage.ts`.
 */
function medePlacas(): readonly PlacaDaTela[] {
  const placas: PlacaDaTela[] = [];
  for (const no of document.querySelectorAll<HTMLElement>('[data-vidro]')) {
    const tipo = no.dataset['vidro'];
    if (tipo !== 'contorno' && tipo !== 'preenchido' && tipo !== 'acento' && tipo !== 'texto') {
      continue;
    }
    const caixa = no.getBoundingClientRect();
    if (caixa.width < 1 || caixa.height < 1) continue;
    placas.push({ x: caixa.left, y: caixa.top, largura: caixa.width, altura: caixa.height, tipo });
  }
  return placas;
}

/**
 * Barra o `click` que vem junto com o `pointerdown` que pulou a abertura.
 *
 * 250 ms é longo o bastante para cobrir o par `pointerdown`/`click` daquele
 * mesmo toque e curto o bastante para o segundo toque já agir normalmente.
 */
function instalaEscudo(): () => void {
  const barra = (evento: Event) => {
    const alvo = evento.target;
    if (!(alvo instanceof Element)) return;
    if (alvo.closest('button, a, input, select, textarea, summary, label') === null) return;
    evento.stopPropagation();
    evento.preventDefault();
  };
  document.addEventListener('click', barra, true);
  const id = window.setTimeout(() => document.removeEventListener('click', barra, true), ESCUDO_MS);
  return () => {
    window.clearTimeout(id);
    document.removeEventListener('click', barra, true);
  };
}

export type Abertura = {
  /** `false` = o canvas saiu do DOM. Nunca escondido: removido. */
  readonly montado: boolean;
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
};

export function useAbertura(): Abertura {
  const [montado, setMontado] = useState(nascePintando);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /*
    Dependências vazias, e isso é o contrário de um descuido.

    A primeira versão dependia de uma `fase` que o próprio efeito atualizava.
    Resultado: `setFase('saindo')` disparava a limpeza do efeito, que cancelava
    o `setTimeout` do fim do crossfade — o canvas ficava para sempre no DOM com
    `opacity: 0`, contexto WebGL vivo, exatamente o que a §7 proíbe. Um efeito
    que escreve no estado de que depende se desmonta no meio do próprio
    trabalho.

    Rodando uma vez, a limpeza só acontece quando a home sai de cena, que é
    quando ela deve mesmo acontecer.
  */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    let vivo = true;
    let quadro = 0;
    let pulou = false;
    let palco: PalcoAbertura | null = null;
    const abortador = new AbortController();
    const temporizadores: number[] = [];
    const limpezas: Array<() => void> = [];

    const desmontaRecursos = () => {
      abortador.abort();
      cancelAnimationFrame(quadro);
      for (const id of temporizadores) window.clearTimeout(id);
      for (const limpar of limpezas) limpar();
      palco?.dispose();
      palco = null;
    };

    /** Fim de verdade: canvas fora do DOM, contexto WebGL descartado (§7). */
    const encerra = () => {
      if (!vivo) return;
      vivo = false;
      aberturaVista();
      desmontaRecursos();
      setMontado(false);
    };

    if (!aberturaPermitida()) {
      encerra();
      return;
    }

    const inicioSondagem = performance.now();
    const temWebGL = suporteDeAbertura();
    const modo = decideModoAbertura({
      movimentoReduzido: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      temWebGL,
      sondagemMs: performance.now() - inicioSondagem,
    });

    if (modo === 'bypass') {
      encerra();
      return;
    }

    /** HANDOFF: crossfade do canvas para o DOM, e o canvas sai (§7). */
    const entregaAoDom = (duracaoS: number) => {
      if (!vivo) return;
      // O critério de aceite da §13 é "duração 1,80 s ± 0,05, medida com
      // performance.now()". Sem uma marca, medir isso de fora vira cronometrar
      // a remoção do canvas — que também carrega compilação de shader e quadro
      // de aquecimento, e num rasterizador por software erra por quase 1 s.
      // Com a marca, `performance.getEntriesByName('tela:abertura')` responde.
      if (performance.getEntriesByName(MARCA_INICIO).length > 0) {
        performance.measure('tela:abertura', MARCA_INICIO);
      }
      const alvo = canvasRef.current;
      if (alvo !== null) {
        alvo.style.transition = `opacity ${Math.round(duracaoS * 1000)}ms linear`;
        alvo.style.opacity = '0';
      }
      temporizadores.push(window.setTimeout(encerra, duracaoS * 1000));
    };

    const dpr = () => Math.min(window.devicePixelRatio, 2);

    void (async () => {
      try {
        const aberto = await Promise.race([
          abrirPalcoAbertura({
            canvas,
            modeloUrl: '/tela-crt.glb',
            placas: medePlacas(),
            larguraCss: window.innerWidth,
            alturaCss: window.innerHeight,
            dpr: dpr(),
            sinal: abortador.signal,
          }),
          new Promise<never>((_, rejeita) => {
            temporizadores.push(
              window.setTimeout(() => rejeita(new Error('modelo atrasado')), PRAZO_MODELO_MS),
            );
          }),
        ]);
        if (!vivo) {
          aberto.dispose();
          return;
        }
        palco = aberto;
      } catch {
        // Abertura que arranca depois de a pessoa já ter visto a tela é pior
        // que abertura nenhuma. Some sem barulho.
        encerra();
        return;
      }

      const emCena = palco;

      const aoRedimensionar = () =>
        emCena.redimensiona(window.innerWidth, window.innerHeight, dpr());
      window.addEventListener('resize', aoRedimensionar);
      limpezas.push(() => window.removeEventListener('resize', aoRedimensionar));

      /**
       * §2, passo 4 — o quadro de aquecimento, agora medido na cena de
       * verdade. Máquina que não desenha o quadro zero em 32 ms não vai
       * sustentar 60 fps num dolly com barril, e cai para a variante parada.
       */
      const aquecimentoMs = emCena.aquece(sampleIntro(0, emCena.zFinal()));

      const forcado = forcada();

      if (forcado?.congeladaEm != null) {
        emCena.render(sampleIntro(forcado.congeladaEm, emCena.zFinal()));
        return;
      }

      if (modo === 'fade' || (forcado === null && !aguentaCoreografia(aquecimentoMs))) {
        // §9 — câmera parada, ruído congelado, sem roll bar e sem barril.
        // Movimento de câmera entrando em objeto é gatilho vestibular, e o
        // dolly com ease-in é justamente o tipo mais provocativo.
        emCena.render(quadroReduzido(emCena.zFinal()));
        entregaAoDom(DURACAO_FADE);
        return;
      }

      /**
       * SKIP (§8): congela, salta para o estado final, desenha um quadro,
       * entra em handoff. **Não** acelera o que falta — quem pulou quer o fim
       * agora, não a mesma coisa em 3×.
       */
      const pula = () => {
        if (!vivo || pulou) return;
        pulou = true;
        cancelAnimationFrame(quadro);
        emCena.render(sampleIntro(DURACAO_ABERTURA, emCena.zFinal()));
        const solta = instalaEscudo();
        limpezas.push(solta);
        entregaAoDom(DURACAO_HANDOFF);
      };

      // Fase de captura: o canvas não recebe ponteiro, então o toque atravessa
      // para o DOM de baixo. Quem impede o botão de responder a esse primeiro
      // toque é o escudo, não o canvas.
      const opcoes = { capture: true } as const;
      for (const gatilho of GATILHOS_DE_SKIP) document.addEventListener(gatilho, pula, opcoes);
      limpezas.push(() => {
        for (const gatilho of GATILHOS_DE_SKIP) document.removeEventListener(gatilho, pula, opcoes);
      });

      performance.mark(MARCA_INICIO);
      const zero = performance.now();
      let pausadoEm: number | null = null;
      let descontado = 0;

      // Aba escondida no meio da abertura não deve voltar no meio do dolly.
      const aoTrocarVisibilidade = () => {
        if (document.hidden) pausadoEm = performance.now();
        else if (pausadoEm !== null) {
          descontado += performance.now() - pausadoEm;
          pausadoEm = null;
        }
      };
      document.addEventListener('visibilitychange', aoTrocarVisibilidade);
      limpezas.push(() =>
        document.removeEventListener('visibilitychange', aoTrocarVisibilidade),
      );

      const laco = () => {
        if (!vivo || pulou) return;
        if (pausadoEm !== null) {
          quadro = requestAnimationFrame(laco);
          return;
        }
        const t = (performance.now() - zero - descontado) / 1000;
        emCena.render(sampleIntro(Math.min(t, DURACAO_ABERTURA), emCena.zFinal()));
        if (t >= DURACAO_ABERTURA) {
          entregaAoDom(DURACAO_HANDOFF);
          return;
        }
        quadro = requestAnimationFrame(laco);
      };
      quadro = requestAnimationFrame(laco);
    })();

    return () => {
      vivo = false;
      desmontaRecursos();
    };
  }, []);

  return { montado, canvasRef };
}

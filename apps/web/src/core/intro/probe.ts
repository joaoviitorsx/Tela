/**
 * A decisão de rodar a abertura, antes de qualquer pixel (§2).
 *
 * Funções puras de propósito: quem mede é o adaptador, quem decide é aqui.
 * Assim a regra "quadro de aquecimento acima de 32 ms cai para FADE" tem teste,
 * e o teste não precisa de GPU.
 */

export type ModoAbertura =
  /** Coreografia inteira, 1,80 s. */
  | 'playing'
  /** Quadro parado e crossfade de 300 ms. `prefers-reduced-motion` ou máquina fraca. */
  | 'fade'
  /** Nada. O canvas nunca é criado. */
  | 'bypass';

export type Sondagem = {
  readonly movimentoReduzido: boolean;
  readonly temWebGL: boolean;
  /** Quanto a sondagem inteira levou. Estourou o orçamento, não vale a pena. */
  readonly sondagemMs: number;
};

/** Acima disto o dispositivo não sustenta 60 fps na coreografia (§2, passo 4). */
export const TETO_AQUECIMENTO_MS = 32;

/** Orçamento total da sondagem (§2, passo 5). */
export const TETO_SONDAGEM_MS = 150;

/**
 * Passos 2, 3 e 5 da §2. O passo 4 é `aguentaCoreografia`, abaixo.
 *
 * # O passo 1 não existe mais
 *
 * A §2 abre bypassando quem já viu, e um critério de aceite da §13 diz "segunda
 * visita: canvas nunca é criado". A abertura passou a rodar em TODA visita à
 * tela inicial — decisão de produto, registrada na ADR 0013.
 *
 * O que segurava esse custo continua de pé e não é pouco: o DOM real está
 * montado, opaco e interativo desde `t = 0` por baixo do canvas (§7), e
 * qualquer toque, tecla ou rolagem pula direto para o fim (§8). Quem já
 * conhece a cena não espera 1,80 s — espera o tempo de encostar na tela.
 */
export function decideModoAbertura(sondagem: Sondagem): ModoAbertura {
  if (sondagem.movimentoReduzido) return 'fade';
  if (!sondagem.temWebGL) return 'fade';
  if (sondagem.sondagemMs > TETO_SONDAGEM_MS) return 'bypass';
  return 'playing';
}

/**
 * Passo 4 da §2 — a proteção real contra máquina fraca.
 *
 * A especificação é explícita sobre por quê: user-agent mente e contagem de
 * núcleos não diz nada sobre a GPU. Um quadro medido, diz.
 *
 * # Por que ele roda DEPOIS do modelo, e não antes
 *
 * Na primeira versão o aquecimento era um triângulo num contexto WebGL
 * descartável, criado dentro do orçamento de 150 ms do passo 5. Medido: o
 * desenho custava 0,3 ms e ABRIR o contexto custava ~150 ms, porque a primeira
 * criação de contexto numa aba paga o aperto de mão com o processo de GPU. Ou
 * seja: o passo 5 reprovava quase todo mundo por causa do custo do próprio
 * passo 4, e a abertura simplesmente não aparecia.
 *
 * Agora o quadro medido é o QUADRO ZERO DA CENA DE VERDADE, no contexto que a
 * abertura vai usar mesmo — que é mais perto do que a §2 pede ("renderiza 1
 * frame de aquecimento e mede") do que um triângulo sintético jamais foi. O
 * passo 5 voltou a medir só o que é barato: `localStorage`, `matchMedia` e a
 * existência de contexto.
 *
 * Custo do desvio: quem reprova aqui já baixou o modelo. Em troca, quem passa
 * — a maioria — vê a abertura em vez de ser barrado pelo próprio termômetro.
 */
export function aguentaCoreografia(aquecimentoMs: number): boolean {
  return aquecimentoMs <= TETO_AQUECIMENTO_MS;
}

/**
 * Prazo para o modelo chegar depois de a sondagem aprovar.
 *
 * Desvio consciente da §2, que não fala de rede. O `.glb` tem 208 KB e o
 * `<link rel="preload">` do `index.html` o baixa em paralelo com o bundle —
 * mas "em paralelo" não é "instantâneo" num 4G brasileiro.
 *
 * Enquanto se espera, o canvas já está de pé pintado de `void`, que é a cor do
 * `body`: para quem olha, é o carregamento normal da página. Se o modelo não
 * chegar dentro do prazo, a abertura vai direto para o handoff em vez de
 * começar tarde — abertura que arranca depois de a pessoa já ter visto a tela
 * é pior que abertura nenhuma.
 */
export const PRAZO_MODELO_MS = 700;

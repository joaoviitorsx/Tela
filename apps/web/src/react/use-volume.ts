import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type PreferenciaVolume = {
  read(): string | null;
  write(value: string): void;
};

export type ControleSom = {
  readonly volume: number;
  readonly mudo: boolean;
  readonly ajustavel: boolean;
  /**
   * O espectador já mexeu no som alguma vez.
   *
   * Separa "o browser bloqueou o autoplay" de "eu escolhi silenciar", que são
   * a mesma variável `mudo` e exigem telas opostas: a primeira pede o overlay
   * grande pedindo um clique; a segunda não pode cobrir o vídeo com nada.
   */
  readonly liberado: boolean;
  readonly ajustar: (valor: number) => void;
  readonly alternarMudo: () => void;
  readonly reativar: () => void;
  readonly empurrar: (delta: number) => void;
};

const PADRAO = 1;
/** Reativar o som em volume zero pareceria botão quebrado. */
const MINIMO_AO_REATIVAR = 0.1;

export const PASSO_VOLUME = 0.05;

let ajustavelCache: boolean | null = null;

/**
 * iOS ignora `video.volume`: a escrita é aceita em silêncio e o valor
 * continua 1. Lá o volume é só do botão físico do aparelho.
 *
 * Detectar é a diferença entre esconder um controle inútil e entregar um que
 * o usuário arrasta e não muda nada — o segundo é pior que não ter.
 */
function volumeAjustavel(): boolean {
  if (ajustavelCache !== null) return ajustavelCache;
  try {
    const teste = document.createElement('video');
    teste.volume = 0.5;
    ajustavelCache = teste.volume === 0.5;
  } catch {
    ajustavelCache = false;
  }
  return ajustavelCache;
}

/** O que voltou do storage pode ser lixo: outra versão, edição manual, cota. */
function sanear(bruto: string | null): number | null {
  if (bruto === null) return null;
  const valor = Number(bruto);
  if (!Number.isFinite(valor) || valor < 0 || valor > 1) return null;
  return valor;
}

/**
 * Volume do espectador, com a regra que os players erram.
 *
 * Duas armadilhas conhecidas, ambas tratadas aqui:
 *
 * 1. O estado "mudo" NUNCA é persistido, e começa sempre em `true`. Autoplay
 *    com som é bloqueado por política de browser — se a página lembrasse "não
 *    estava mudo" e tentasse tocar com som, o browser recusaria o play
 *    INTEIRO e o espectador veria tela preta em vez de vídeo. O volume é
 *    lembrado; o mudo é imposto.
 *
 * 2. Tirar do mudo com o volume em zero não faz som nenhum, e o usuário
 *    conclui que o botão está quebrado. Por isso reativar em zero sobe para
 *    um mínimo audível.
 */
export function useVolume(pref: PreferenciaVolume): ControleSom {
  const [volume, definir] = useState<number>(() => sanear(pref.read()) ?? PADRAO);
  const [mudo, mutar] = useState(true);
  const [liberado, liberar] = useState(false);

  /**
   * Só grava depois que alguém mexeu. Antes disso o efeito escrevia "1.00" na
   * montagem de toda visita — escrita em disco por página aberta, para gravar
   * exatamente o valor que já estava lá.
   */
  const tocado = useRef(false);
  useEffect(() => {
    if (!tocado.current) return;
    pref.write(volume.toFixed(2));
  }, [pref, volume]);

  const ajustar = useCallback((valor: number) => {
    const limitado = Math.min(1, Math.max(0, valor));
    definir(limitado);
    // Mexer na barra é intenção de ouvir. Zero é silêncio; acima disso, som.
    mutar(limitado === 0);
    liberar(true);
    tocado.current = true;
  }, []);

  const alternarMudo = useCallback(() => {
    if (mudo && volume === 0) definir(MINIMO_AO_REATIVAR);
    mutar(!mudo);
    liberar(true);
    tocado.current = true;
  }, [mudo, volume]);

  const reativar = useCallback(() => {
    if (volume === 0) definir(MINIMO_AO_REATIVAR);
    mutar(false);
    liberar(true);
    tocado.current = true;
  }, [volume]);

  const empurrar = useCallback(
    (delta: number) => ajustar(Number((volume + delta).toFixed(2))),
    [ajustar, volume],
  );

  /**
   * Objeto estável: ele alimenta o mapa de atalhos, e um mapa novo a cada
   * render reassinaria o listener de teclado sessenta vezes por segundo.
   */
  return useMemo(
    () => ({
      volume,
      mudo,
      liberado,
      ajustavel: volumeAjustavel(),
      ajustar,
      alternarMudo,
      reativar,
      empurrar,
    }),
    [volume, mudo, liberado, ajustar, alternarMudo, reativar, empurrar],
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import { decidirTentativa, ofereceAbrirNoApp } from '../core/domain/abrir-no-app.js';
import type { AbrirNoApp, MarcaSemApp } from '../core/ports/abrir-no-app.js';

/**
 * - `tentando`: o `tela://` foi lançado e se espera, no máximo 1,5 s, o foco
 *   sair da página. O viewer da web NÃO conecta nesse intervalo.
 * - `no-app`: o app assumiu. O viewer da web não conecta (senão a mesma
 *   pessoa ocuparia duas vagas da sala).
 * - `navegador`: segue pelo navegador — o caminho de quem não tem o app.
 */
export type FaseDoApp = 'tentando' | 'no-app' | 'navegador';

export type AbrirNoAppManual = 'ocioso' | 'tentando' | 'falhou';

export type AbrirNoAppEstado = {
  readonly fase: FaseDoApp;
  /** O botão ABRIR NO APP existe neste aparelho (Windows/Linux, fora do app). */
  readonly oferece: boolean;
  /** O resultado do botão manual: a página só fala quando falha. */
  readonly manual: AbrirNoAppManual;
  /** Botão ABRIR NO APP: tenta de novo, a pedido, e limpa a marca "sem app". */
  readonly abrir: () => void;
  /** Botão "continuar no navegador": fica de vez (grava a marca "sem app"). */
  readonly continuarNoNavegador: () => void;
};

/**
 * A tentativa automática de abrir o app (PLANO-desktop §14), UMA vez por visita.
 *
 * A decisão inicial é síncrona (`useState`): onde não há o que tentar — celular,
 * Mac, Safari, dentro do app, aparelho já marcado — a fase nasce `navegador` e
 * o viewer conecta no mesmo render de sempre, sem 1 ms de espera. Só quem pode
 * ter o app e ainda não foi testado paga até `PRAZO_DA_TENTATIVA_MS`, uma vez:
 * sem resposta, a marca `tela.semApp` evita a espera nas visitas seguintes.
 */
export function useAbrirNoApp(slug: string, abrirNoApp: AbrirNoApp, marca: MarcaSemApp): AbrirNoAppEstado {
  const ambiente = abrirNoApp.ambiente();
  const [fase, setFase] = useState<FaseDoApp>(() =>
    decidirTentativa(abrirNoApp.ambiente(), marca.ler()).tentar ? 'tentando' : 'navegador',
  );
  const [manual, setManual] = useState<AbrirNoAppManual>('ocioso');

  /*
    `vivo` e `iniciada` são refs e não dependências do efeito: o StrictMode
    monta, desmonta e monta de novo, e a segunda montagem NÃO pode lançar uma
    segunda tentativa — "uma vez" é requisito, o app pergunta "Abrir Tela?".
  */
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  const iniciada = useRef(false);
  useEffect(() => {
    if (fase !== 'tentando' || iniciada.current) return;
    iniciada.current = true;
    void abrirNoApp.tentar(slug).then((resultado) => {
      if (!vivo.current) return;
      if (resultado === 'abriu') {
        setFase('no-app');
      } else {
        marca.gravar();
        setFase('navegador');
      }
    });
  }, [fase, slug, abrirNoApp, marca]);

  const abrir = useCallback(() => {
    marca.limpar();
    setManual('tentando');
    void abrirNoApp.tentar(slug).then((resultado) => {
      if (!vivo.current) return;
      if (resultado === 'abriu') {
        setManual('ocioso');
        setFase('no-app');
      } else {
        marca.gravar();
        setManual('falhou');
      }
    });
  }, [slug, abrirNoApp, marca]);

  const continuarNoNavegador = useCallback(() => {
    marca.gravar();
    setManual('ocioso');
    setFase('navegador');
  }, [marca]);

  return { fase, oferece: ofereceAbrirNoApp(ambiente), manual, abrir, continuarNoNavegador };
}

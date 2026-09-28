import { useCallback, useRef, useState } from 'react';
import type { Medida } from '../components/Medidor.js';
import { concluirSonda, type ConclusaoSonda } from '../core/media/sonda-de-rede.js';
import type { ResultadoBrutoSonda, SondaDeRede } from '../core/ports/sonda-de-rede.js';

export const BLOCOS_DO_TESTE = 16;

export type TesteDeRede = {
  readonly fase: 'parado' | 'testando' | 'pronto';
  /** Quantos dos `BLOCOS_DO_TESTE` estão acesos. */
  readonly blocos: number;
  readonly conclusao: ConclusaoSonda | null;
  readonly bruto: ResultadoBrutoSonda | null;
  readonly testar: () => void;
};

/** Ponte fina para a sonda: estado da barra e da conclusão, nada mais. */
export function useTesteDeRede(sonda: SondaDeRede): TesteDeRede {
  const [fase, setFase] = useState<TesteDeRede['fase']>('parado');
  const [blocos, setBlocos] = useState(0);
  const [bruto, setBruto] = useState<ResultadoBrutoSonda | null>(null);
  const correndo = useRef(false);

  const testar = useCallback(() => {
    if (correndo.current) return;
    correndo.current = true;
    setFase('testando');
    setBlocos(0);
    void sonda
      .testar((fracao) => setBlocos(Math.round(fracao * BLOCOS_DO_TESTE)))
      .then((resultado) => {
        setBruto(resultado);
        setFase('pronto');
      })
      .finally(() => {
        correndo.current = false;
      });
  }, [sonda]);

  return {
    fase,
    blocos,
    bruto,
    conclusao: bruto === null ? null : concluirSonda(bruto),
    testar,
  };
}

/** O cartão "CONEXÃO DIRETA" a partir do teste. */
export function medidaDaConexaoDireta(teste: TesteDeRede): Medida {
  const c = teste.conclusao;
  if (teste.fase === 'testando') return { rotulo: 'CONEXÃO DIRETA', valor: '…', nota: 'consultando dois servidores STUN' };
  if (c === null) return { rotulo: 'CONEXÃO DIRETA', valor: '— —', nota: 'rode o teste abaixo' };
  switch (c.direta) {
    case 'provavel':
      return {
        rotulo: 'CONEXÃO DIRETA',
        valor: 'PROVÁVEL',
        tom: 'ok',
        nota: `STUN respondeu${c.respostaMs === null ? '' : ` em ${c.respostaMs} ms`}; sua rede permite P2P`,
      };
    case 'improvavel':
      return {
        rotulo: 'CONEXÃO DIRETA',
        valor: 'IMPROVÁVEL',
        tom: 'alerta',
        nota: 'NAT simétrico: amigos fora da sua rede vão entrar pelo TURN',
      };
    case 'bloqueada':
      return {
        rotulo: 'CONEXÃO DIRETA',
        valor: 'BLOQUEADA',
        tom: 'alerta',
        nota: 'STUN não respondeu: UDP de saída barrado; só o TURN conecta',
      };
    case 'falhou':
      return { rotulo: 'CONEXÃO DIRETA', valor: 'SEM TESTE', tom: 'alerta', nota: `o navegador recusou (${c.erro})` };
  }
}

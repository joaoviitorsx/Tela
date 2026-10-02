import { useEffect, useSyncExternalStore } from 'react';
import { SeletorDeSom, type OpcaoDeSom } from '../components/SeletorDeSom.js';
import type { ResumoDoSom, SomDoApp } from '../react/som-do-app.js';
import type { EstadoDoSom, SomDesktop } from './som-desktop.js';

/**
 * O que a home recebe do app no passo ÁUDIO (D3): o seletor das três opções e
 * o resumo do que vai ao ar. Os dois leem a MESMA loja (`som-desktop.ts`), a
 * que o adapter de áudio consulta ao capturar — a interface não guarda cópia
 * da escolha.
 */

/** O `audioDeviceId` que a home entrega à sessão: só avisa "há som a capturar". */
export const ID_DE_AUDIO_DO_APP = 'app-desktop';

export function resumoDoSom(estado: EstadoDoSom): ResumoDoSom {
  return {
    curto: estado.real.curto,
    real: estado.real.rotulo,
    mudo: estado.real.curto === 'SEM SOM',
    idDeAudio: estado.escolha.tipo === 'nenhum' ? null : ID_DE_AUDIO_DO_APP,
    pendente: estado.pendente,
  };
}

export function criarSomDoApp(som: SomDesktop): SomDoApp {
  function Seletor() {
    const estado = useSyncExternalStore(som.assinar, som.snapshot, som.snapshot);
    // Só pergunta ao sistema (e lista apps) enquanto a interface está à vista.
    useEffect(() => som.observar(), []);

    const jogo = estado.escolha.tipo === 'jogo' ? estado.escolha : null;
    const escolher = (opcao: OpcaoDeSom): void => {
      if (opcao === 'sistema') som.escolherSistema();
      else if (opcao === 'nenhum') som.escolherNenhum();
      else som.escolherJogo();
    };
    return (
      <SeletorDeSom
        opcao={estado.escolha.tipo}
        componenteDisponivel={estado.capacidades === null ? null : estado.capacidades.jogo.disponivel}
        motivoDoComponente={estado.capacidades?.jogo.motivo ?? null}
        apps={estado.apps}
        appEscolhido={jogo?.appId ?? null}
        listando={estado.listando}
        real={estado.real}
        aoEscolherOpcao={escolher}
        aoEscolherApp={(id) => {
          const app = estado.apps.find((a) => a.id === id);
          if (app !== undefined) som.escolherApp(app);
        }}
        aoAtualizar={som.atualizarApps}
      />
    );
  }

  function useResumo(): ResumoDoSom {
    return resumoDoSom(useSyncExternalStore(som.assinar, som.snapshot, som.snapshot));
  }

  return { Seletor, useResumo };
}

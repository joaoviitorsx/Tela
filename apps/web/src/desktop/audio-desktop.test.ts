import { describe, expect, it, vi } from 'vitest';
import type { AudioCapture, AudioDevice } from '../core/ports/audio-capture.js';
import { acharMonitor, makeAudioDesktop } from './audio-desktop.js';
import type { FimDoSomDoJogo, RespostaSomJogo, RespostaSomSistema } from './ponte.js';
import type { PortaReal } from './porta-nativa.js';
import type { EscolhaDeSom, ResultadoDoSom } from './som-desktop.js';

const ENTRADA_SISTEMA: AudioDevice = { id: 'm1', label: 'Tela-Sistema-Entrada', tipo: 'monitor' };
const ENTRADA_JOGO: AudioDevice = { id: 'm2', label: 'Tela-Jogo-Entrada', tipo: 'monitor' };
const MIC: AudioDevice = { id: 'mic', label: 'Microfone interno', tipo: 'entrada' };

function trilhaFalsa(): MediaStreamTrack & { eventos: string[] } {
  const eventos: string[] = [];
  return {
    eventos,
    stop: () => eventos.push('stop'),
    dispatchEvent: (e: Event) => {
      eventos.push(e.type);
      return true;
    },
  } as unknown as MediaStreamTrack & { eventos: string[] };
}

function montar(opcoes: {
  escolha: EscolhaDeSom;
  dispositivos?: readonly AudioDevice[][];
  iniciarJogo?: RespostaSomJogo;
  iniciarSistema?: RespostaSomSistema;
}) {
  const registros: ResultadoDoSom[] = [];
  const fins: Array<(f: FimDoSomDoJogo) => void> = [];
  const pararSom = vi.fn();
  const trilha = trilhaFalsa();
  const listas = [...(opcoes.dispositivos ?? [[ENTRADA_SISTEMA, ENTRADA_JOGO, MIC]])];
  const navegador: AudioCapture = {
    requestPermission: () => Promise.resolve(true),
    listMonitors: () => Promise.resolve([...(listas.length > 1 ? listas.shift()! : (listas[0] ?? []))]),
    capture: vi.fn(() => Promise.resolve(trilha)),
  };
  const trilhaPcm = trilhaFalsa();
  const encerrar = vi.fn();
  const portaFalsa = { postMessage: () => undefined, onmessage: null, close: () => undefined } as PortaReal;
  const audio = makeAudioDesktop({
    ponte: {
      som: {
        capacidades: () => Promise.resolve({ jogo: { disponivel: true, motivo: null } }),
        listarApps: () => Promise.resolve([]),
        iniciarJogo: () => Promise.resolve(opcoes.iniciarJogo ?? { ok: true, app: 'Minecraft', via: 'entrada', descricao: 'Tela-Jogo-Entrada' }),
        pararSom,
        iniciarSistema: () => Promise.resolve(opcoes.iniciarSistema ?? { ok: true, via: 'entrada', descricao: 'Tela-Sistema-Entrada' }),
        aoEncerrar: (o) => {
          fins.push(o);
          return () => fins.splice(fins.indexOf(o), 1);
        },
      },
    },
    som: { escolhaAtual: () => opcoes.escolha, registrar: (r) => registros.push(r) },
    navegador,
    portas: { aguardar: () => Promise.resolve(portaFalsa) },
    criarTrilhaDePcm: () => Promise.resolve({ trilha: trilhaPcm, encerrar }),
    esperar: () => Promise.resolve(),
  });
  return { audio, registros, fins, pararSom, trilha, trilhaPcm, encerrar, navegador };
}

const JOGO: EscolhaDeSom = { tipo: 'jogo', appId: 'pid:10', nome: 'Minecraft' };

describe('acharMonitor', () => {
  it('casa pelo rótulo, sem maiúsculas', () => {
    expect(acharMonitor([MIC, ENTRADA_JOGO], 'tela-jogo-entrada')?.id).toBe('m2');
    expect(acharMonitor([MIC], 'Tela-Jogo-Entrada')).toBeNull();
  });
});

describe('Linux, Sistema', () => {
  it('pede ao main a fonte virtual do sistema e a captura pelo rótulo', async () => {
    const { audio, navegador, registros } = montar({ escolha: { tipo: 'sistema' } });
    await audio.capture('qualquer');
    expect(navegador.capture).toHaveBeenCalledWith('m1');
    expect(registros).toEqual([{ situacao: 'ativo' }]);
  });

  it('não achando a fonte: desfaz no main e falha com motivo, em vez de capturar o microfone', async () => {
    const { audio, registros, navegador, pararSom } = montar({ escolha: { tipo: 'sistema' }, dispositivos: [[MIC]] });
    await expect(audio.capture('x')).rejects.toThrow();
    expect(navegador.capture).not.toHaveBeenCalled();
    expect(pararSom).toHaveBeenCalledTimes(1);
    expect(registros).toEqual([{ situacao: 'falhou', motivo: 'o navegador não enxergou o som do sistema' }]);
  });

  it('o main recusou (sem PipeWire): o motivo vai à interface', async () => {
    const { audio, registros } = montar({ escolha: { tipo: 'sistema' }, iniciarSistema: { ok: false, erro: 'INDISPONIVEL' } });
    await expect(audio.capture('x')).rejects.toThrow();
    expect(registros[0]).toMatchObject({ situacao: 'falhou' });
  });

  it('parar a trilha remove a fonte virtual', async () => {
    const { audio, pararSom } = montar({ escolha: { tipo: 'sistema' } });
    (await audio.capture('x')).stop();
    expect(pararSom).toHaveBeenCalledTimes(1);
  });
});

describe('Windows, Sistema (tudo menos a call)', () => {
  const resposta: RespostaSomSistema = { ok: true, via: 'porta', id: 7 };

  it('monta a trilha a partir da porta do PCM — tela ou janela, tanto faz', async () => {
    const { audio, trilhaPcm, registros, navegador } = montar({ escolha: { tipo: 'sistema' }, iniciarSistema: resposta });
    expect(await audio.capture('x')).toBe(trilhaPcm);
    expect(registros).toEqual([{ situacao: 'ativo' }]);
    expect(navegador.capture).not.toHaveBeenCalled();
  });

  it('parar a trilha para o addon; o componente caindo encerra a trilha e diz por quê', async () => {
    const { audio, pararSom, fins, encerrar, registros } = montar({ escolha: { tipo: 'sistema' }, iniciarSistema: resposta });
    const t = await audio.capture('x');
    fins[0]!({ motivo: 'COMPONENTE_CAIU' });
    expect(encerrar).toHaveBeenCalledTimes(1);
    expect(registros.at(-1)).toEqual({ situacao: 'parou', motivo: 'o componente de som caiu' });
    t.stop();
    expect(pararSom).toHaveBeenCalledTimes(1);
  });

  it('Windows antigo ou sem addon: o motivo vem do main, nada de loopback com a call no lugar', async () => {
    const { audio, registros, navegador } = montar({ escolha: { tipo: 'sistema' }, iniciarSistema: { ok: false, erro: 'INDISPONIVEL' } });
    await expect(audio.capture('x')).rejects.toThrow();
    expect(registros[0]).toEqual({ situacao: 'falhou', motivo: 'o componente de som não está disponível' });
    expect(navegador.capture).not.toHaveBeenCalled();
  });
});

describe('Sem som', () => {
  it('recusa: a home nem deveria pedir', async () => {
    const { audio, registros } = montar({ escolha: { tipo: 'nenhum' } });
    await expect(audio.capture('x')).rejects.toThrow();
    expect(registros).toEqual([]);
  });
});

describe('Linux, Só o jogo', () => {
  it('espera o Chromium enxergar o sink novo e captura o monitor dele', async () => {
    // As duas primeiras listagens ainda não têm o sink.
    const { audio, navegador, registros } = montar({ escolha: JOGO, dispositivos: [[MIC], [MIC], [MIC, ENTRADA_JOGO]] });
    await audio.capture('x');
    expect(navegador.capture).toHaveBeenCalledWith('m2');
    expect(registros).toEqual([{ situacao: 'ativo' }]);
  });

  it('parar a trilha devolve o roteamento (uma vez)', async () => {
    const { audio, pararSom, trilha } = montar({ escolha: JOGO });
    const t = await audio.capture('x');
    t.stop();
    t.stop();
    expect(pararSom).toHaveBeenCalledTimes(1);
    expect(trilha.eventos.filter((e) => e === 'stop')).toHaveLength(2);
  });

  it('o sink nunca aparece: desfaz o roteamento e falha com motivo', async () => {
    const { audio, pararSom, registros } = montar({ escolha: JOGO, dispositivos: [[MIC]] });
    await expect(audio.capture('x')).rejects.toThrow();
    expect(pararSom).toHaveBeenCalledTimes(1);
    expect(registros[0]).toMatchObject({ situacao: 'falhou' });
  });

  it('o jogo some no meio: a trilha acaba com `ended` e a interface diz por quê', async () => {
    const { audio, fins, registros, trilha } = montar({ escolha: JOGO });
    await audio.capture('x');
    fins[0]!({ motivo: 'SINK_CAIU' });
    expect(trilha.eventos).toContain('ended');
    expect(registros.at(-1)).toEqual({ situacao: 'parou', motivo: 'o som parou' });
  });

  it('o main recusou: o motivo do erro vai à interface', async () => {
    const { audio, registros } = montar({ escolha: JOGO, iniciarJogo: { ok: false, erro: 'APP_NAO_ENCONTRADO' } });
    await expect(audio.capture('x')).rejects.toThrow();
    expect(registros).toEqual([{ situacao: 'falhou', motivo: 'esse programa não está mais tocando' }]);
  });

  it('só o jogo sem jogo escolhido falha sem chamar o main', async () => {
    const { audio, registros } = montar({ escolha: { tipo: 'jogo', appId: null, nome: null } });
    await expect(audio.capture('x')).rejects.toThrow();
    expect(registros[0]).toMatchObject({ situacao: 'falhou' });
  });
});

describe('Windows, Só o jogo', () => {
  const resposta: RespostaSomJogo = { ok: true, app: 'Minecraft', via: 'porta', id: 4 };

  it('monta a trilha a partir da porta do PCM', async () => {
    const { audio, trilhaPcm, registros } = montar({ escolha: JOGO, iniciarJogo: resposta });
    expect(await audio.capture('x')).toBe(trilhaPcm);
    expect(registros).toEqual([{ situacao: 'ativo' }]);
  });

  it('parar a trilha para o addon; o fim por fora encerra a trilha', async () => {
    const { audio, pararSom, fins, encerrar, trilhaPcm } = montar({ escolha: JOGO, iniciarJogo: resposta });
    const t = await audio.capture('x');
    fins[0]!({ motivo: 'PROCESSO_ENCERROU' });
    expect(encerrar).toHaveBeenCalledTimes(1);
    t.stop();
    expect(pararSom).toHaveBeenCalledTimes(1);
    expect(trilhaPcm.eventos).toContain('stop');
  });

  it('Windows antigo ou sem addon: o motivo vem do main, nada de som do sistema no lugar', async () => {
    const { audio, registros, navegador } = montar({ escolha: JOGO, iniciarJogo: { ok: false, erro: 'INDISPONIVEL' } });
    await expect(audio.capture('x')).rejects.toThrow();
    expect(registros[0]).toEqual({ situacao: 'falhou', motivo: 'o componente de som não está disponível' });
    expect(navegador.capture).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  criarEmissorDeEstado,
  estadoParaOMain,
  FORA_DO_AR,
  rotaDosEspectadores,
  rotuloDoEncoder,
  tempoNoAr,
} from './estado-ao-vivo.js';
import type { EstadoAoVivo } from './ponte.js';
import { estadoVivo, par } from './testes-de-sessao.js';

const NO_AR: EstadoAoVivo = { noAr: true, inicioMs: 1000, assistindo: 1, capacidade: 50, link: 'https://tela.gg/jv' };

describe('estadoParaOMain', () => {
  it('fora do ar não carrega link nem contagem', () => {
    expect(estadoParaOMain({ status: 'idle' }, 5)).toBe(FORA_DO_AR);
    expect(estadoParaOMain({ status: 'ended', reason: 'USER_STOPPED' }, 5)).toBe(FORA_DO_AR);
    expect(estadoParaOMain({ status: 'connecting' }, null)).toBe(FORA_DO_AR);
  });
  it('ao vivo conta só quem recebe imagem, com o teto da sala e o link', () => {
    const estado = estadoVivo({ peers: [par('a', 'connected'), par('b', 'connecting'), par('c', 'connected', true)], maxPeers: 50 });
    expect(estadoParaOMain(estado, 1234)).toEqual({
      noAr: true,
      inicioMs: 1234,
      assistindo: 2,
      capacidade: 50,
      link: 'https://tela.gg/jv',
    });
  });
});

describe('rota e encoder', () => {
  it('direta, TURN ou mista — só entre os conectados', () => {
    expect(rotaDosEspectadores(estadoVivo())).toBe('—');
    expect(rotaDosEspectadores(estadoVivo({ peers: [par('a', 'connected')] }))).toBe('direta');
    expect(rotaDosEspectadores(estadoVivo({ peers: [par('a', 'connected', true)] }))).toBe('TURN');
    expect(rotaDosEspectadores(estadoVivo({ peers: [par('a', 'connected'), par('b', 'connected', true)] }))).toBe('mista');
    expect(rotaDosEspectadores(estadoVivo({ peers: [par('a', 'connecting', true)] }))).toBe('—');
    expect(rotaDosEspectadores({ status: 'idle' })).toBe('—');
  });
  it('o encoder vem do transporte, como veio', () => {
    expect(rotuloDoEncoder(estadoVivo({ encoder: 'nativo·NVENC' }))).toBe('nativo·NVENC');
    expect(rotuloDoEncoder(estadoVivo({ encoder: 'WebCodecs·hardware' }))).toBe('WebCodecs·hardware');
    expect(rotuloDoEncoder(estadoVivo())).toBe('—');
    expect(rotuloDoEncoder({ status: 'idle' })).toBe('—');
  });
});

describe('tempoNoAr', () => {
  it('mm:ss e h:mm:ss', () => {
    expect(tempoNoAr(1000, 43_000)).toBe('00:42');
    expect(tempoNoAr(1, 3_725_001)).toBe('1:02:05');
    expect(tempoNoAr(null, 5)).toBe('--:--');
  });
});

describe('criarEmissorDeEstado', () => {
  function montar() {
    let agora = 0;
    const tarefas: Array<{ fn: () => void; em: number; viva: boolean }> = [];
    const enviar = vi.fn();
    const emissor = criarEmissorDeEstado({
      enviar,
      agora: () => agora,
      agendar: (fn, ms) => {
        const t = { fn, em: agora + ms, viva: true };
        tarefas.push(t);
        return () => {
          t.viva = false;
        };
      },
    });
    const avancar = (ms: number) => {
      agora += ms;
      for (const t of tarefas) if (t.viva && t.em <= agora) {
        t.viva = false;
        t.fn();
      }
    };
    return { emissor, enviar, avancar };
  }

  it('o primeiro "fora do ar" não vai: o main já começa assim', () => {
    const { emissor, enviar } = montar();
    emissor.empurrar(FORA_DO_AR);
    expect(enviar).not.toHaveBeenCalled();
    emissor.empurrar(NO_AR);
    expect(enviar).toHaveBeenCalledTimes(1);
  });
  it('o primeiro estado vai na hora', () => {
    const { emissor, enviar } = montar();
    emissor.empurrar(NO_AR);
    expect(enviar).toHaveBeenCalledTimes(1);
  });
  it('o que não mudou não é reenviado', () => {
    const { emissor, enviar, avancar } = montar();
    emissor.empurrar(NO_AR);
    avancar(5000);
    emissor.empurrar({ ...NO_AR });
    avancar(5000);
    expect(enviar).toHaveBeenCalledTimes(1);
  });
  it('mudanças em rajada saem no máximo 1 vez por segundo, com o valor mais recente', () => {
    const { emissor, enviar, avancar } = montar();
    emissor.empurrar(NO_AR);
    avancar(100);
    emissor.empurrar({ ...NO_AR, assistindo: 2 });
    avancar(100);
    emissor.empurrar({ ...NO_AR, assistindo: 3 });
    expect(enviar).toHaveBeenCalledTimes(1);
    avancar(800);
    expect(enviar).toHaveBeenCalledTimes(2);
    expect(enviar).toHaveBeenLastCalledWith({ ...NO_AR, assistindo: 3 });
  });
  it('depois de uma pausa, a mudança vai na hora', () => {
    const { emissor, enviar, avancar } = montar();
    emissor.empurrar(NO_AR);
    avancar(2000);
    emissor.empurrar({ ...NO_AR, assistindo: 4 });
    expect(enviar).toHaveBeenCalledTimes(2);
  });
  it('voltar ao valor já enviado durante a espera não gera envio', () => {
    const { emissor, enviar, avancar } = montar();
    emissor.empurrar(NO_AR);
    avancar(100);
    emissor.empurrar({ ...NO_AR, assistindo: 2 });
    emissor.empurrar(NO_AR);
    avancar(1000);
    expect(enviar).toHaveBeenCalledTimes(1);
  });
  it('cancelar descarta o pendente', () => {
    const { emissor, enviar, avancar } = montar();
    emissor.empurrar(NO_AR);
    avancar(100);
    emissor.empurrar({ ...NO_AR, assistindo: 2 });
    emissor.cancelar();
    avancar(2000);
    expect(enviar).toHaveBeenCalledTimes(1);
  });
});

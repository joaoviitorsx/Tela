import { describe, expect, it } from 'vitest';
import type { MediaStats } from '../ports/media-transport.js';
import { Diario } from './diagnostico.js';

const stats: MediaStats = {
  fps: 60, bitrateBps: 8_000_000, rttMs: 24, limitation: 'none',
  width: 1920, height: 1080, availableBps: null, piorAvailableBps: null,
  paresMedidos: 1, availablePorPeer: {}, bpp: 0.11,
  encoderImplementation: null, qp: null, msPorQuadro: null, recepcao: null, audio: null,
};

describe('Diario', () => {
  it('guarda o rótulo do codificador único do app (D9), e ainda recusa endereço', () => {
    const diario = new Diario('transmissor');
    diario.iniciar('s', null);
    for (const encoder of ['WebCodecs·hardware', 'WebCodecs·software·GPU caiu', 'nativo·falhou(PORTAL)']) {
      diario.registrar({ ...stats, encoderImplementation: encoder }, 1);
      expect(diario.relatorio('Chrome/152').encoder).toBe(encoder);
    }
    diario.registrar({ ...stats, encoderImplementation: 'nativo·(192.0.2.1)' }, 2);
    expect(diario.relatorio('Chrome/152').encoder).toBeNull();
  });

  it('exporta falha antes da primeira amostra sem dados sensíveis', () => {
    const diario = new Diario('espectador');
    diario.iniciar('sessao:segredo', 'build@invalido');
    diario.tentativa('tentativa:segredo', 10);
    diario.evento('signaling', 'SIGNALING_UNAVAILABLE', 20);
    diario.congelar();
    diario.evento('session', 'ENDED', 30);

    const relatorio = diario.relatorio('Chrome/127 token=segredo 192.0.2.1');
    expect(relatorio).toMatchObject({
      versao: 3,
      versaoApp: null,
      sessaoId: 'sessaosegredo',
      tentativaId: 'tentativasegredo',
      navegador: 'Chrome/127',
      amostras: [],
    });
    expect(relatorio.eventos.map((evento) => evento.codigo)).toEqual([
      'ATTEMPT', 'SIGNALING_UNAVAILABLE',
    ]);
    expect(JSON.stringify(relatorio)).not.toContain('192.0.2.1');
    expect(JSON.stringify(relatorio)).not.toContain('token=');
  });

  it('limita eventos e limpa somente quando uma nova sessão começa', () => {
    const diario = new Diario('transmissor');
    diario.iniciar('first', 'abc123');
    diario.tentativa('one', 0);
    for (let i = 0; i < 100; i += 1) diario.evento('ice', 'RECONNECTING', i);
    for (let i = 0; i < 150; i += 1) diario.registrar(stats, i);
    diario.registrar({ ...stats, encoderImplementation: 'Encoder 192.0.2.1' }, 151);
    expect(diario.relatorio('Firefox/130').eventos).toHaveLength(64);
    expect(diario.relatorio('Firefox/130').amostras).toHaveLength(120);
    expect(diario.relatorio('Firefox/130').encoder).toBeNull();
    diario.congelar();
    expect(diario.relatorio('Firefox/130').eventos).toHaveLength(64);
    expect(diario.relatorio('Firefox/130').amostras).toHaveLength(120);
    diario.iniciar('second', null);
    expect(diario.vazio).toBe(true);
    expect(diario.relatorio('Firefox/130').sessaoId).toBe('second');
  });
});

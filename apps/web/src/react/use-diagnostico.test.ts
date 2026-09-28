import { describe, expect, it } from 'vitest';
import type { BroadcastState } from '../core/media/broadcast-session.js';
import { montarDiagnostico } from './use-diagnostico.js';
import type { ReadableStats } from './use-media-stats.js';

type Vivo = Extract<BroadcastState, { status: 'live' }>;

const STATS: ReadableStats = {
  resolution: '1280×720',
  fps: '60fps',
  bitrate: '9.4 Mbps',
  rtt: '48ms',
  warning: null,
  bpp: '0,113',
  bppBaixo: false,
  encoder: 'hardware',
  qp: '—',
  latencia: '—',
  congelado: '—',
  travou: false,
  msPorQuadro: '—',
  encoderLento: false,
  qpAlto: false,
};

function vivo(sobre: Partial<Vivo> = {}): Vivo {
  return {
    status: 'live',
    shareUrl: 'https://tela.gg/jv#k=abc',
    slug: 'jv',
    presetId: 'p1080p60',
    presetForced: false,
    peers: [],
    maxPeers: 5,
    stats: null,
    hasAudio: true,
    capturaSemImagem: false,
    motivoDegradacao: null,
    volumeAudio: 1,
    audio: 'transmitindo',
    grafoAudio: 'rodando',
    volumeAjustavel: true,
    semSinalizacao: false,
    preview: null,
    prioridade: 'fluidez',
    audioPerdidoPelaEscolha: false,
    ...sobre,
  } as Vivo;
}

describe('montarDiagnostico', () => {
  it('sem espectadores diz isso, em vez de inventar uma rota', () => {
    const d = montarDiagnostico(vivo(), STATS);

    expect(d.espectadores).toEqual([]);
    expect(d.resumo.find((c) => c.rotulo === 'CONEXÃO')).toMatchObject({ valor: '—', tom: 'neutro' });
    expect(d.resumo.find((c) => c.rotulo === 'ESPECTADORES')?.valor).toBe('0/5');
  });

  it('separa P2P direto de TURN por espectador, com o que o PeerInfo realmente carrega', () => {
    const d = montarDiagnostico(
      vivo({
        peers: [
          { id: 'a', connectionState: 'connected', usingRelay: false },
          { id: 'b', connectionState: 'connected', usingRelay: true },
          { id: 'c', connectionState: 'connecting', usingRelay: false },
          { id: 'd', connectionState: 'disconnected', usingRelay: false },
        ],
      }),
      STATS,
    );

    expect(d.espectadores.map((e) => [e.nome, e.rota, e.estado])).toEqual([
      ['ESPECTADOR 1', 'P2P direto', 'assistindo'],
      ['ESPECTADOR 2', 'TURN (relay)', 'assistindo'],
      ['ESPECTADOR 3', 'P2P direto', 'conectando'],
      ['ESPECTADOR 4', 'P2P direto', 'reconectando'],
    ]);
    const conexao = d.resumo.find((c) => c.rotulo === 'CONEXÃO');
    expect(conexao).toMatchObject({ valor: '1 VIA TURN', tom: 'alerta' });
    expect(d.resumo.find((c) => c.rotulo === 'ESPECTADORES')?.nota).toBe('2 recebendo vídeo');
  });

  it('não inventa latência nem perda por espectador: só o pior RTT agregado', () => {
    const d = montarDiagnostico(vivo({ peers: [{ id: 'a', connectionState: 'connected', usingRelay: false }] }), STATS);

    const chaves = Object.keys(d.espectadores[0] ?? {});
    expect(chaves).not.toContain('latencia');
    expect(chaves).not.toContain('perda');
    expect(d.resumo.find((c) => c.rotulo === 'PIOR LATÊNCIA')?.valor).toBe('48ms');
  });

  it('a limitação e o áudio saem do estado da sessão', () => {
    const d = montarDiagnostico(vivo({ motivoDegradacao: 'cpu', audio: 'bloqueado' }), STATS);

    expect(d.resumo.find((c) => c.rotulo === 'LIMITAÇÃO')).toMatchObject({ valor: 'CPU', tom: 'alerta' });
    expect(d.audio.tom).toBe('alerta');
    expect(d.audio.texto).toMatch(/pausou o áudio/);
  });
});

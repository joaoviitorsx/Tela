import { describe, expect, it } from 'vitest';
import type { BroadcastState } from '../core/media/broadcast-session.js';
import { montarDiagnostico } from './use-diagnostico.js';
import type { ReadableStats } from './use-media-stats.js';

type Vivo = Extract<BroadcastState, { status: 'live' }>;

const STATS: ReadableStats = {
  resolution: '1280×720',
  fps: '60 fps',
  bitrate: '9.4 Mbps',
  rtt: '48ms',
  warning: null,
  bpp: '0,113',
  bppBaixo: false,
  repasse: null,
  segurados: null,
  seguradosAlto: false,
  encoder: 'hardware',
  qp: '—',
  latencia: '—',
  congelado: '—',
  travou: false,
  msPorQuadro: '—',
  codifica: 'GPU',
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

  describe('veredito (C-05)', () => {
    const peer = (sobre: Partial<Vivo['peers'][number]> = {}) => ({
      id: 'a',
      connectionState: 'connected' as const,
      usingRelay: false,
      ...sobre,
    });

    it('sem espectador, espera o primeiro amigo', () => {
      const v = montarDiagnostico(vivo(), STATS).veredito;
      expect(v.tom).toBe('neutro');
      expect(v.texto).toMatch(/Aguardando o primeiro amigo/);
    });

    it('tudo bem: diz quantos recebem, em que qualidade e que a conexão é direta', () => {
      const v = montarDiagnostico(vivo({ peers: [peer()] }), STATS).veredito;
      expect(v).toEqual({
        tom: 'ok',
        texto: 'Tudo certo: 1 amigo recebendo 1280×720 a 60 fps, em conexão direta.',
      });
    });

    it('subida que não aguenta vira aviso com o que está saindo', () => {
      const v = montarDiagnostico(vivo({ peers: [peer()], motivoDegradacao: 'bandwidth' }), STATS).veredito;
      expect(v.tom).toBe('alerta');
      expect(v.texto).toMatch(/subida não sustenta.*1280×720/);
    });

    it('o aviso de rede do console também vira veredito, sem contradição com o banner', () => {
      const v = montarDiagnostico(
        vivo({ peers: [peer()] }),
        { ...STATS, warning: 'Rede no limite — reduzindo qualidade' },
      ).veredito;
      expect(v.tom).toBe('alerta');
      expect(v.texto).toBe('! Rede no limite — reduzindo qualidade. Enviando 1280×720.');
    });

    it('CPU no limite manda fechar programas', () => {
      const v = montarDiagnostico(vivo({ peers: [peer()], motivoDegradacao: 'cpu' }), STATS).veredito;
      expect(v.texto).toMatch(/não está dando conta de codificar/);
    });

    it('amigo via TURN e amigo ainda conectando têm frase própria, com singular e plural', () => {
      const turn = montarDiagnostico(vivo({ peers: [peer({ usingRelay: true })] }), STATS).veredito;
      expect(turn.texto).toMatch(/1 amigo está pela rota alternativa/);
      const conectando = montarDiagnostico(
        vivo({ peers: [peer(), peer({ id: 'b', connectionState: 'connecting' }), peer({ id: 'c', connectionState: 'failed' })] }),
        STATS,
      ).veredito;
      expect(conectando.texto).toMatch(/2 amigos ainda não estão recebendo/);
    });

    it('som com problema vira aviso mesmo com a imagem boa', () => {
      const v = montarDiagnostico(vivo({ peers: [peer()], audio: 'bloqueado' }), STATS).veredito;
      expect(v.tom).toBe('alerta');
      expect(v.texto).toMatch(/pausou o áudio/);
    });
  });
});

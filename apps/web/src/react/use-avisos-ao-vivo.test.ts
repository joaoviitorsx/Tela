import { describe, expect, it } from 'vitest';
import type { BroadcastState } from '../core/media/broadcast-session.js';
import { montarAvisos } from './use-avisos-ao-vivo.js';

type Vivo = Extract<BroadcastState, { status: 'live' }>;

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

const chaves = (v: Vivo, momentaneo: string | null = null) =>
  montarAvisos(v, momentaneo).map((a) => a.chave);

describe('montarAvisos', () => {
  it('tudo bem: nenhum aviso', () => {
    expect(chaves(vivo())).toEqual([]);
  });

  it('ordena pelo que mais dói: sem imagem, sem servidor, som, qualidade', () => {
    const v = vivo({
      capturaSemImagem: true,
      semSinalizacao: true,
      audio: 'sem-sinal',
      presetForced: true,
      motivoDegradacao: 'cpu',
    });
    expect(chaves(v)).toEqual(['sem-sinal', 'sem-sinalizacao', 'audio', 'degradado']);
  });

  it('a causa da degradação muda o texto: CPU manda olhar o hardware, rede não', () => {
    const cpu = montarAvisos(vivo({ presetForced: true, motivoDegradacao: 'cpu' }), null)[0]?.texto;
    const rede = montarAvisos(vivo({ presetForced: true, motivoDegradacao: 'bandwidth' }), null)[0]?.texto;

    expect(cpu).toMatch(/chrome:\/\/gpu/);
    expect(rede).toMatch(/subida/);
    expect(rede).not.toMatch(/chrome:\/\/gpu/);
  });

  it('o aviso do instante some quando a degradação já o explica', () => {
    expect(chaves(vivo({ presetForced: true, motivoDegradacao: 'cpu' }), 'CPU no limite')).toEqual(['degradado']);
    expect(chaves(vivo(), 'Rede no limite')).toEqual(['aviso']);
  });

  it('avisa quando um espectador perdeu a conexão', () => {
    const v = vivo({ peers: [{ id: 'a', connectionState: 'disconnected', usingRelay: false }] });
    expect(chaves(v)).toEqual(['reconectando']);
  });

  it('só os estados de áudio que pedem ação de quem transmite viram aviso', () => {
    expect(chaves(vivo({ audio: 'mudo' }))).toEqual([]);
    expect(chaves(vivo({ audio: 'sem-fonte' }))).toEqual([]);
    expect(chaves(vivo({ audio: 'bloqueado' }))).toEqual(['audio']);
    expect(chaves(vivo({ audio: 'encerrada' }))).toEqual(['audio']);
  });
});

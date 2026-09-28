import { describe, expect, it } from 'vitest';
import { FakeMediaTransport, FakeScheduler, fakeStream, fakeTrack } from '../testing/fakes.js';
import { ViewerSession } from './viewer-session.js';

const SLUG = 'joao';
const settle = async (times = 12) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

function build(configure: (t: FakeMediaTransport) => void = () => undefined) {
  const criados: FakeMediaTransport[] = [];
  const scheduler = new FakeScheduler();
  const session = new ViewerSession({
    transport: () => {
      const t = new FakeMediaTransport();
      configure(t);
      criados.push(t);
      return t;
    },
    scheduler,
    statsIntervalMs: 1_000,
  });
  return { criados, scheduler, session, ultimo: () => criados.at(-1)! };
}

describe('ViewerSession', () => {
  it('mantém tentativa e erro de signaling após fechar o transporte', async () => {
    const ctx = build((t) => { t.watchError = { code: 'SIGNAL_UNREACHABLE' }; });
    await ctx.session.open(SLUG);
    await settle();
    await ctx.session.close();
    const relatorio = ctx.session.diagnostico('Firefox/130');
    expect(relatorio?.eventos.map((evento) => evento.codigo)).toContain('SIGNALING_UNAVAILABLE');
    expect(relatorio?.eventos.at(-1)?.codigo).toBe('ENDED');
  });

  it('entra no canal e mostra a mídia quando ela chega', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    expect(ctx.session.getState().status).toBe('connecting');

    ctx.ultimo().deliver();
    expect(ctx.session.getState().status).toBe('watching');
    expect(ctx.ultimo().watched).toBe(SLUG);
  });

  it('ninguém transmitindo não é erro — vira offline com nova tentativa', async () => {
    const ctx = build((t) => {
      t.watchError = { code: 'NOT_HOSTING' };
    });
    await ctx.session.open(SLUG);
    await settle();

    const state = ctx.session.getState();
    expect(state.status).toBe('offline');
    expect(state.status === 'offline' && state.nextPollMs).toBe(5_000);
    expect(ctx.scheduler.pending).toBe(1);
  });

  it('conecta sozinho quando a transmissão sobe', async () => {
    let offline = true;
    const ctx = build((t) => {
      if (offline) t.watchError = { code: 'NOT_HOSTING' };
    });
    await ctx.session.open(SLUG);
    await settle();

    offline = false;
    ctx.scheduler.advance(5_000);
    await settle(20);
    ctx.ultimo().deliver();

    expect(ctx.session.getState().status).toBe('watching');
  });

  it('servidor inalcançável NÃO é reportado como "sem transmissão"', async () => {
    // Foi o bug do Brave: o WebSocket não abria, o cliente reportava
    // NOT_HOSTING, e o usuário via "ninguém está transmitindo, aguardando"
    // enquanto a transmissão estava no ar o tempo todo. Todo bloqueio de
    // navegador, proxy ou queda de rede virava a mesma mensagem errada.
    const ctx = build((t) => {
      t.watchError = { code: 'SIGNAL_UNREACHABLE' };
    });
    await ctx.session.open(SLUG);
    await settle();

    expect(ctx.session.getState().status).toBe('sem-servidor');
  });

  it('servidor volta e o espectador entra sozinho', async () => {
    let bloqueado = true;
    const ctx = build((t) => {
      if (bloqueado) t.watchError = { code: 'SIGNAL_UNREACHABLE' };
    });
    await ctx.session.open(SLUG);
    await settle();
    expect(ctx.session.getState().status).toBe('sem-servidor');

    bloqueado = false;
    // Só até a nova tentativa: passar de 15s dispararia o relógio da
    // negociação antes de a mídia chegar, que é outro caso.
    ctx.scheduler.advance(8_000);
    await settle(20);
    ctx.ultimo().deliver();

    expect(ctx.session.getState().status).toBe('watching');
  });

  it('canal cheio vira estado próprio e continua tentando', async () => {
    const ctx = build((t) => {
      t.watchError = { code: 'CHANNEL_FULL' };
    });
    await ctx.session.open(SLUG);
    await settle();

    expect(ctx.session.getState().status).toBe('full');
    expect(ctx.scheduler.pending).toBeGreaterThan(0);
  });

  it('canal cheio volta para offline quando a transmissão acaba', async () => {
    let cheio = true;
    const ctx = build((t) => {
      t.watchError = cheio ? { code: 'CHANNEL_FULL' } : { code: 'NOT_HOSTING' };
    });
    await ctx.session.open(SLUG);
    await settle();
    expect(ctx.session.getState().status).toBe('full');

    cheio = false;
    ctx.scheduler.advance(10_000);
    await settle(20);

    // Continuar dizendo "lotada" depois que ninguém transmite é mentira.
    expect(ctx.session.getState().status).toBe('offline');
  });

  it('faz backoff de 5s até 30s enquanto continua offline', async () => {
    const ctx = build((t) => {
      t.watchError = { code: 'NOT_HOSTING' };
    });
    await ctx.session.open(SLUG);
    await settle();

    const vistos: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const s = ctx.session.getState();
      if (s.status === 'offline') vistos.push(s.nextPollMs);
      ctx.scheduler.advance(30_000);
      await settle(20);
    }

    expect(vistos[0]).toBe(5_000);
    expect(Math.max(...vistos)).toBeLessThanOrEqual(30_000);
  });

  it('cada rodada faz exatamente uma tentativa, sem dobrar', async () => {
    // Falha dupla: o `watch` rejeita E o transporte emite `closed`. É o modo
    // real de falha do WebSocket, e era o que dobrava as tentativas a cada
    // rodada: 1, 2, 4, 8, 16, 32.
    const ctx = build((t) => {
      t.watchError = { code: 'NOT_HOSTING' };
      queueMicrotask(() => t.emit('closed', { reason: 'SIGNAL_CLOSED' }));
    });
    await ctx.session.open(SLUG);
    await settle(20);

    const porRodada: number[] = [ctx.criados.length];
    for (let i = 0; i < 5; i += 1) {
      const antes = ctx.criados.length;
      ctx.scheduler.advance(60_000);
      await settle(40);
      porRodada.push(ctx.criados.length - antes);
    }
    expect(porRodada).toEqual([1, 1, 1, 1, 1, 1]);
  });

  it('30 rodadas offline não acumulam timers pendentes', async () => {
    const ctx = build((t) => {
      t.watchError = { code: 'NOT_HOSTING' };
    });
    await ctx.session.open(SLUG);

    for (let i = 0; i < 30; i += 1) {
      ctx.scheduler.advance(30_000);
      await settle(20);
    }
    expect(ctx.scheduler.pending).toBe(1);
  });

  it('reconnecting volta para watching quando a mídia retorna', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    ctx.ultimo().deliver();
    expect(ctx.session.getState().status).toBe('watching');

    ctx.ultimo().emit('reconnecting', undefined);
    expect(ctx.session.getState().status).toBe('reconnecting');

    // Sem isto, `reconnecting` era beco sem saída: a mídia voltava e a tela
    // ficava morta, porque a rota desmonta o <video> fora de `watching`.
    ctx.ultimo().emit('reconnected', undefined);
    expect(ctx.session.getState().status).toBe('watching');
  });

  it('queda do SERVIDOR não tira o espectador do ar', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    ctx.ultimo().deliver();
    expect(ctx.session.getState().status).toBe('watching');

    ctx.ultimo().loseSignaling();
    await settle(20);

    // A conexão com quem transmite é direta. Perder o servidor não é perder
    // o vídeo — é só não conseguir mais entrar em canais novos.
    expect(ctx.session.getState().status).toBe('watching');
    expect(ctx.ultimo().disconnected).toBe(false);
  });

  it('queda do transmissor volta para offline e reconecta depois', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    ctx.ultimo().deliver();

    ctx.ultimo().emit('closed', { reason: 'HOST_LEFT' });
    await settle(20);
    expect(ctx.session.getState().status).toBe('offline');

    ctx.scheduler.advance(5_000);
    await settle(20);
    ctx.ultimo().deliver();
    expect(ctx.session.getState().status).toBe('watching');
  });

  it('negociação que nunca settla não deixa a aba presa em connecting', async () => {
    const ctx = build((t) => {
      t.hangOnWatch = true;
    });
    void ctx.session.open(SLUG);
    await settle(20);
    expect(ctx.session.getState().status).toBe('connecting');

    ctx.scheduler.advance(20_000);
    await settle(40);

    // Negociou e a mídia nunca veio: é estado próprio, não "offline". A ação
    // de quem lê é diferente — não adianta só esperar.
    expect(ctx.session.getState().status).toBe('sem-conexao');
    expect(ctx.scheduler.pending).toBeGreaterThan(0);
  });

  it('reusa participante e troca tentativa ao reconectar', async () => {
    let offline = true;
    const ctx = build((t) => { if (offline) t.watchError = { code: 'NOT_HOSTING' }; });
    await ctx.session.open(SLUG);
    const first = ctx.ultimo().watchIdentity;
    offline = false;
    ctx.scheduler.advance(5_000);
    await settle();
    const second = ctx.ultimo().watchIdentity;
    expect(second?.participantId).toBe(first?.participantId);
    expect(second?.attemptId).not.toBe(first?.attemptId);
  });

  it('tentativa manual não recarrega a sessão nem deixa o timer antigo disparar', async () => {
    let offline = true;
    const ctx = build((t) => { if (offline) t.watchError = { code: 'NOT_HOSTING' }; });
    await ctx.session.open(SLUG);
    const first = ctx.ultimo().watchIdentity;
    offline = false;
    await ctx.session.retryNow();
    const second = ctx.ultimo().watchIdentity;
    ctx.scheduler.advance(5_000);
    await settle();
    expect(ctx.criados).toHaveLength(2);
    expect(second?.participantId).toBe(first?.participantId);
    expect(second?.attemptId).not.toBe(first?.attemptId);
  });

  it('não corta o restart ICE inicial pelo vigia normal de 15 segundos', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    ctx.scheduler.advance(5_000);
    ctx.ultimo().emit('reconnecting', undefined);
    ctx.scheduler.advance(10_000);
    await settle();
    expect(ctx.session.getState().status).toBe('connecting');
    ctx.scheduler.advance(20_000);
    await settle();
    expect(ctx.session.getState().status).toBe('sem-conexao');
  });

  it('preserva indisponibilidade do relay quando a mídia não chega', async () => {
    const ctx = build((t) => { t.relayStatus = 'unavailable'; });
    await ctx.session.open(SLUG);
    ctx.scheduler.advance(15_000);
    await settle(30);
    expect(ctx.session.getState()).toEqual({
      status: 'sem-conexao',
      slug: SLUG,
      relayStatus: 'unavailable',
      etapa: 'rede',
    });
    expect(ctx.session.diagnostico('Chrome/130')?.eventos.map((evento) => evento.codigo)).toContain('RELAY_UNAVAILABLE');
  });

  it('mídia que chega depois do timeout não ressuscita a tentativa antiga', async () => {
    const ctx = build((t) => {
      t.hangOnWatch = true;
    });
    void ctx.session.open(SLUG);
    await settle(20);
    ctx.scheduler.advance(20_000);
    await settle(40);

    const antigo = ctx.criados[0]!;
    antigo.deliver();
    expect(ctx.session.getState().status).not.toBe('watching');
  });

  it('amostra estatísticas enquanto assiste', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    ctx.ultimo().deliver();
    ctx.ultimo().stats = {
      fps: 60,
      bitrateBps: 7_400_000,
      rttMs: 142,
      limitation: 'none',
      width: 1920,
      height: 1080,
      availableBps: null,
      bpp: 0.1,
      encoderImplementation: null,
      qp: null,
      msPorQuadro: null,
      recepcao: null,
      audio: null,
      piorAvailableBps: null,
      paresMedidos: 1,
      availablePorPeer: {},
    };

    ctx.scheduler.advance(1_000);
    await settle(20);

    const state = ctx.session.getState();
    expect(state.status === 'watching' && state.stats?.rttMs).toBe(142);
  });

  it('detecta áudio no stream entregue', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    ctx.ultimo().deliver(fakeStream([fakeTrack('video'), fakeTrack('audio')]));
    const state = ctx.session.getState();
    expect(state.status === 'watching' && state.hasAudio).toBe(true);
  });

  it('close cancela tudo e não reconecta mais', async () => {
    const ctx = build((t) => {
      t.watchError = { code: 'NOT_HOSTING' };
    });
    await ctx.session.open(SLUG);
    await ctx.session.close();

    ctx.scheduler.advance(60_000);
    await settle(20);

    expect(ctx.session.getState().status).not.toBe('watching');
    expect(ctx.criados.every((t) => t.disconnected)).toBe(true);
  });

  it('dois open() concorrentes: o obsoleto não derruba o transporte do vivo', async () => {
    // React em StrictMode monta, desmonta e monta de novo — dois `open`
    // correm juntos. A tentativa obsoleta chegava a fechar o transporte da
    // tentativa viva, e a rejeição resultante era reportada como "offline"
    // quando o motivo real era outro.
    const ctx = build((t) => {
      t.watchError = { code: 'CHANNEL_FULL' };
    });

    const primeiro = ctx.session.open(SLUG);
    const segundo = ctx.session.open(SLUG);
    await Promise.all([primeiro, segundo]);
    await settle(30);

    // O motivo real precisa sobreviver à corrida.
    expect(ctx.session.getState().status).toBe('full');
  });

  it('dois open() concorrentes não deixam transporte órfão vivo', async () => {
    const ctx = build();
    const primeiro = ctx.session.open(SLUG);
    const segundo = ctx.session.open('outro');
    await Promise.all([primeiro, segundo]);
    await settle(30);

    // Todos menos o vencedor precisam ter sido desconectados.
    const vivos = ctx.criados.filter((t) => !t.disconnected);
    expect(vivos.length).toBeLessThanOrEqual(1);
  });

  it('aba escondida não faz rede nenhuma', async () => {
    // O espectador foi jogar e deixou a aba aberta. Ele não está olhando —
    // e o produto inteiro existe para não atrapalhar quem está jogando.
    const ctx = build((t) => {
      t.watchError = { code: 'NOT_HOSTING' };
    });
    await ctx.session.open(SLUG);
    await settle();
    const antes = ctx.criados.length;

    ctx.scheduler.setVisivel(false);
    for (let i = 0; i < 10; i += 1) {
      ctx.scheduler.advance(30_000);
      await settle();
    }

    expect(ctx.criados.length).toBe(antes);
  });

  it('voltar para a aba retoma na hora, sem esperar o próximo tique', async () => {
    const ctx = build((t) => {
      t.watchError = { code: 'NOT_HOSTING' };
    });
    await ctx.session.open(SLUG);
    await settle();

    ctx.scheduler.setVisivel(false);
    ctx.scheduler.advance(60_000);
    await settle();
    const escondido = ctx.criados.length;

    ctx.scheduler.setVisivel(true);
    await settle(20);

    expect(ctx.criados.length).toBeGreaterThan(escondido);
  });

  it('abrir outro slug desconecta o transporte anterior', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    await ctx.session.open('outro');
    await settle();
    expect(ctx.criados[0]?.disconnected).toBe(true);
  });
});

describe('ViewerSession — a imagem sobrevive ao soluço (ADR 0018)', () => {
  it('reconnecting CARREGA o stream, para o <video> não ser desmontado', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    ctx.ultimo().deliver();
    await settle();

    const antes = ctx.session.getState();
    const stream = antes.status === 'watching' ? antes.stream : null;
    expect(stream).not.toBeNull();

    /*
      `reconnecting` é emitido por `track.onmute` e por
      `connectionState === 'disconnected'`. Numa troca de AP de Wi-Fi o ICE
      falha os consent checks por alguns segundos COM o mesmo par de
      candidatos entregando pacotes — a mídia não parou.

      Sem o stream no estado, a rota caía na tela de espera e arrancava um
      <video> que nunca parou de receber quadros.
    */
    ctx.ultimo().emit('reconnecting', undefined);

    const durante = ctx.session.getState();
    expect(durante.status).toBe('reconnecting');
    expect(durante.status === 'reconnecting' && durante.stream).toBe(stream);
  });

  it('sem mídia nunca entregue, reconnecting não inventa stream', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    ctx.ultimo().emit('reconnecting', undefined);

    const estado = ctx.session.getState();
    if (estado.status === 'reconnecting') expect(estado.stream).toBeNull();
  });
});

describe('ViewerSession — estado do áudio (TELA-007)', () => {
  const comAudio = (ocultacao: number) => ({
    fps: 60, bitrateBps: 8_000_000, rttMs: 20, limitation: 'none' as const,
    width: 1920, height: 1080, availableBps: null, piorAvailableBps: null,
    paresMedidos: 1, availablePorPeer: {}, bpp: 0.1, encoderImplementation: null,
    qp: null, msPorQuadro: null, recepcao: null,
    audio: {
      fluxos: 1, bitrateBps: 128_000, nivel: 0.1, perda: 0.08, jitterMs: 12,
      jitterBufferMs: 60, ocultacao, eventosOcultacao: 4, codec: null, configuracao: null,
    },
  });
  const audioDe = (s: ViewerSession) => {
    const st = s.getState();
    return st.status === 'watching' ? st.audio : null;
  };

  it('stream só com vídeo é sem-fonte', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    ctx.ultimo().deliver();
    expect(audioDe(ctx.session)).toBe('sem-fonte');
  });

  it('autoplay bloqueado informado pela página vira bloqueado na próxima amostra', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    ctx.ultimo().deliver(fakeStream([fakeTrack('video'), fakeTrack('audio')]));
    expect(audioDe(ctx.session)).toBe('desconhecido');
    ctx.session.informarReproducao({ bloqueada: true, mudo: true });
    ctx.ultimo().stats = comAudio(0);
    ctx.scheduler.advance(1_000);
    await settle(20);
    expect(audioDe(ctx.session)).toBe('bloqueado');
  });

  it('ocultação sustentada vira perda, e a série do diagnóstico traz o áudio', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    ctx.ultimo().deliver(fakeStream([fakeTrack('video'), fakeTrack('audio')]));
    ctx.ultimo().stats = comAudio(0.12);
    for (let i = 0; i < 3; i += 1) {
      ctx.scheduler.advance(1_000);
      await settle(20);
    }
    expect(audioDe(ctx.session)).toBe('perda');
    const relatorio = ctx.session.diagnostico('Chrome/130');
    expect(relatorio?.eventos.map((e) => e.codigo)).toContain('AUDIO_LOSS');
    expect(relatorio?.amostras.at(-1)).toMatchObject({
      audioKbps: 128, audioNivelDb: -20, audioPerdaPct: 8, audioOcultacaoPct: 12,
      audioJitterMs: 12, audioBufferMs: 60,
    });
  });
});

describe('ViewerSession — primeiro quadro e etapa da falha (TELA-013)', () => {
  it('áudio chegando antes do vídeo NÃO declara watching nem desarma o vigia', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    ctx.ultimo().deliver(fakeStream([fakeTrack('audio')]));
    expect(ctx.session.getState().status).toBe('connecting');

    ctx.scheduler.advance(15_000);
    await settle(30);
    expect(ctx.session.getState()).toMatchObject({ status: 'sem-conexao' });
  });

  it('áudio antes, vídeo depois: entra assistindo, com áudio', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    ctx.ultimo().deliver(fakeStream([fakeTrack('audio')]));
    ctx.ultimo().deliver(fakeStream([fakeTrack('video'), fakeTrack('audio')]));
    const st = ctx.session.getState();
    expect(st.status).toBe('watching');
    expect(st.status === 'watching' && st.hasAudio).toBe(true);
  });

  it('conexão nunca fechou: etapa rede, evento NO_ROUTE', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    ctx.scheduler.advance(15_000);
    await settle(30);
    expect(ctx.session.getState()).toMatchObject({ status: 'sem-conexao', etapa: 'rede' });
    expect(ctx.session.diagnostico('Chrome/130')?.eventos.map((e) => e.codigo)).toContain('NO_ROUTE');
  });

  it('conectou e o quadro não veio: etapa mídia, sem culpar a rede', async () => {
    const ctx = build();
    await ctx.session.open(SLUG);
    ctx.ultimo().emit('ice-conectado', undefined);
    ctx.scheduler.advance(15_000);
    await settle(30);
    expect(ctx.session.getState()).toMatchObject({ status: 'sem-conexao', etapa: 'midia' });
    const codigos = ctx.session.diagnostico('Chrome/130')?.eventos.map((e) => e.codigo);
    expect(codigos).toContain('MEDIA_TIMEOUT');
    expect(codigos).not.toContain('NO_ROUTE');
  });
});

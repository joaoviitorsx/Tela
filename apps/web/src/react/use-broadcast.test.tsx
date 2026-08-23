// @vitest-environment happy-dom
import { StrictMode, useEffect } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { BroadcastSession } from '../core/media/broadcast-session.js';
import {
  FakeAudioCapture,
  FakeMediaTransport,
  FakeScheduler,
  FakeScreenCapture,
  createStream,
  shareUrlFor,
} from '../core/testing/fakes.js';
import { useBroadcast } from './use-broadcast.js';

/**
 * A camada React é fina, mas é onde o produto quebrou de verdade.
 *
 * O bug: `start` era recriado a cada mudança de estado, então todo efeito que
 * o tivesse nas dependências re-rodava a cada transição — e o cleanup desse
 * efeito parava a transmissão. A primeira transição já matava a sessão, e o
 * usuário via "Transmissão encerrada" antes do seletor de tela aparecer.
 *
 * Nenhum teste de sessão pegava isso, porque a sessão estava correta. O
 * defeito morava na ponte.
 */
afterEach(cleanup);

const SLUG = 'joao';
const TOKEN = 'o'.repeat(43);

function build() {
  const transport = new FakeMediaTransport();
  const screen = new FakeScreenCapture();
  const session = new BroadcastSession({
    transport,
    screen,
    audio: new FakeAudioCapture(),
    scheduler: new FakeScheduler(),
    shareUrlFor,
    createStream,
  });
  return { session, transport, screen };
}

const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
};

describe('useBroadcast', () => {
  it('as ações são referencialmente estáveis entre mudanças de estado', async () => {
    const ctx = build();
    const identidades: unknown[] = [];

    function Sonda() {
      const { state, start, stop, setPreset } = useBroadcast(ctx.session);
      identidades.push({ start, stop, setPreset, status: state.status });
      return null;
    }

    render(<Sonda />);
    await act(async () => {
      await ctx.session.start(SLUG, TOKEN);
    });
    await settle();

    // Vários estados observados...
    const status = new Set(identidades.map((i) => (i as { status: string }).status));
    expect(status.size).toBeGreaterThan(1);

    // ...e a MESMA função em todos eles.
    const primeiras = identidades[0] as { start: unknown; stop: unknown; setPreset: unknown };
    for (const i of identidades) {
      const atual = i as { start: unknown; stop: unknown; setPreset: unknown };
      expect(atual.start).toBe(primeiras.start);
      expect(atual.stop).toBe(primeiras.stop);
      expect(atual.setPreset).toBe(primeiras.setPreset);
    }
  });

  it('um efeito que depende de `start` não roda o cleanup a cada transição', async () => {
    const ctx = build();
    let limpezas = 0;

    function Rota() {
      const { start } = useBroadcast(ctx.session);
      useEffect(() => {
        void start(SLUG, TOKEN);
        return () => {
          limpezas += 1;
        };
      }, [start]);
      return null;
    }

    render(<Rota />);
    await settle();

    // Este é o cenário exato do bug: o cleanup chamava session.stop().
    expect(limpezas).toBe(0);
    expect(ctx.session.getState().status).toBe('live');
  });

  it('StrictMode: monta, desmonta e monta de novo sem deixar a sessão encerrada', async () => {
    const ctx = build();

    function Rota() {
      const { start } = useBroadcast(ctx.session);
      useEffect(() => {
        void start(SLUG, TOKEN);
        return () => {
          void ctx.session.stop('USER_STOPPED');
        };
      }, [start]);
      return null;
    }

    render(
      <StrictMode>
        <Rota />
      </StrictMode>,
    );
    await settle();

    // Com a guarda `started.current` que existia antes, o segundo mount não
    // reiniciava e o usuário ficava preso em "Transmissão encerrada".
    expect(ctx.session.getState().status).toBe('live');
  });
});

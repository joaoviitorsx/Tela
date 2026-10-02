// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppComSom, CapacidadesDeSom } from './ponte.js';
import { makeSomDesktop } from './som-desktop.js';
import { criarSomDoApp, ID_DE_AUDIO_DO_APP, resumoDoSom } from './SomDoAppDesktop.js';

afterEach(cleanup);

const MINECRAFT: AppComSom = { id: 'pid:10', nome: 'Minecraft', tocando: true, icone: null };

function montar(capacidades: CapacidadesDeSom = { jogo: { disponivel: true, motivo: null } }, plataforma: 'win32' | 'linux' = 'win32') {
  const som = makeSomDesktop({
    plataforma,
    capacidades: () => Promise.resolve(capacidades),
    listarApps: () => Promise.resolve([MINECRAFT]),
    agendar: () => () => undefined,
  });
  return { som, app: criarSomDoApp(som) };
}

const assentar = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('resumoDoSom', () => {
  it('sem som não entrega id de áudio à sessão; os outros entregam', () => {
    const { som } = montar();
    expect(resumoDoSom(som.snapshot())).toMatchObject({ curto: 'SEM SOM', mudo: true, idDeAudio: null });
    som.escolherSistema();
    expect(resumoDoSom(som.snapshot())).toMatchObject({ curto: 'SISTEMA', mudo: false, idDeAudio: ID_DE_AUDIO_DO_APP, pendente: null });
    som.escolherJogo();
    expect(resumoDoSom(som.snapshot())).toMatchObject({ idDeAudio: ID_DE_AUDIO_DO_APP, pendente: expect.stringContaining('Escolha o jogo') });
  });
});

describe('Seletor do app', () => {
  it('escolher "só o jogo", escolher o app e ver o modo real mudar', async () => {
    const { app, som } = montar();
    render(<app.Seletor />);
    await assentar();
    fireEvent.click(screen.getByRole('radio', { name: /SÓ O JOGO/ }));
    await assentar();
    fireEvent.click(screen.getByRole('radio', { name: /Minecraft/ }));
    expect(som.snapshot().escolha).toEqual({ tipo: 'jogo', appId: 'pid:10', nome: 'Minecraft' });
    expect(screen.getByRole('status').textContent).toContain('SÓ O JOGO · Minecraft');
  });

  it('sem o componente de som, "sistema" e "só o jogo" vêm desabilitados com o motivo do main', async () => {
    const { app } = montar({ jogo: { disponivel: false, motivo: 'Precisa do PipeWire.' } }, 'linux');
    render(<app.Seletor />);
    await assentar();
    expect(screen.getByRole('radio', { name: /SÓ O JOGO/ }).textContent).toContain('Precisa do PipeWire.');
    expect(screen.getByRole('radio', { name: /SISTEMA/ }).textContent).toContain('Precisa do PipeWire.');
  });

  it('Sistema escolhido: o modo real diz que vai tudo menos a call, no Windows e no Linux', async () => {
    for (const plataforma of ['win32', 'linux'] as const) {
      const { app, som } = montar(undefined, plataforma);
      som.escolherSistema();
      render(<app.Seletor />);
      await assentar();
      expect(screen.getByRole('status').textContent).toContain('SISTEMA · tudo menos a call');
      cleanup();
    }
  });

  it('o modo real reflete uma falha registrada pelo adapter', async () => {
    const { app, som } = montar();
    som.escolherSistema();
    render(<app.Seletor />);
    await assentar();
    act(() => som.registrar({ situacao: 'falhou', motivo: 'o Windows recusou' }));
    expect(screen.getByRole('status').textContent).toContain('SEM SOM · o Windows recusou');
  });

  it('só pergunta ao main enquanto está montado', async () => {
    const listar = vi.fn(() => Promise.resolve([MINECRAFT]));
    const som = makeSomDesktop({ plataforma: 'win32', capacidades: () => Promise.resolve({ jogo: { disponivel: true, motivo: null } }), listarApps: listar, agendar: () => () => undefined });
    const app = criarSomDoApp(som);
    som.escolherJogo();
    expect(listar).not.toHaveBeenCalled();
    const { unmount } = render(<app.Seletor />);
    await assentar();
    expect(listar).toHaveBeenCalledTimes(1);
    unmount();
  });
});

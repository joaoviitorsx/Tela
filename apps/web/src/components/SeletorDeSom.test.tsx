// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AppNaLista, SeletorDeSom } from './SeletorDeSom.js';

afterEach(cleanup);

const APPS: readonly AppNaLista[] = [
  { id: 'pid:10', nome: 'Minecraft', tocando: true, icone: 'data:image/png;base64,AA==' },
  { id: 'pid:20', nome: 'Discord', tocando: false, icone: null },
];

function montar(props: Partial<Parameters<typeof SeletorDeSom>[0]> = {}) {
  const aoEscolherOpcao = vi.fn();
  const aoEscolherApp = vi.fn();
  const aoAtualizar = vi.fn();
  const utils = render(
    <SeletorDeSom
      opcao="sistema"
      jogoDisponivel={true}
      motivoDoJogo={null}
      apps={APPS}
      appEscolhido={null}
      listando={false}
      real={{ rotulo: 'SISTEMA · inclui a call', tom: 'ok' }}
      avisoDoSistema={null}
      aoEscolherOpcao={aoEscolherOpcao}
      aoEscolherApp={aoEscolherApp}
      aoAtualizar={aoAtualizar}
      {...props}
    />,
  );
  return { ...utils, aoEscolherOpcao, aoEscolherApp, aoAtualizar };
}

describe('SeletorDeSom: as três opções', () => {
  it('mostra Sistema, Só o jogo e Sem som como rádios; a escolhida está marcada', () => {
    montar();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(screen.getByRole('radio', { name: /SÓ O JOGO/ })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: /O QUE SEUS AMIGOS VÃO OUVIR/ })).toBeTruthy();
  });

  it('só a opção marcada entra na ordem do Tab (roving tabindex)', () => {
    montar({ opcao: 'nenhum' });
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);
  });

  it('clicar escolhe; as setas movem a seleção entre as opções', () => {
    const { aoEscolherOpcao } = montar();
    fireEvent.click(screen.getByRole('radio', { name: /SEM SOM/ }));
    expect(aoEscolherOpcao).toHaveBeenLastCalledWith('nenhum');
    fireEvent.keyDown(screen.getAllByRole('radio')[0]!, { key: 'ArrowRight' });
    expect(aoEscolherOpcao).toHaveBeenLastCalledWith('jogo');
  });

  it('as setas pulam "só o jogo" quando está indisponível, e o motivo aparece NA opção', () => {
    const { aoEscolherOpcao } = montar({ jogoDisponivel: false, motivoDoJogo: 'Precisa do Windows 10 versão 2004.' });
    const jogo = screen.getByRole('radio', { name: /SÓ O JOGO/ });
    expect(jogo.getAttribute('aria-disabled')).toBe('true');
    expect(jogo.textContent).toContain('Precisa do Windows 10 versão 2004.');
    fireEvent.click(jogo);
    expect(aoEscolherOpcao).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getAllByRole('radio')[0]!, { key: 'ArrowRight' });
    expect(aoEscolherOpcao).toHaveBeenLastCalledWith('nenhum');
  });

  it('enquanto o sistema responde, "só o jogo" diz que está verificando', () => {
    montar({ jogoDisponivel: null });
    expect(screen.getByText('VERIFICANDO…')).toBeTruthy();
  });

  it('avisa do som do sistema no Windows, só quando Sistema está escolhido', () => {
    montar({ avisoDoSistema: 'Vai junto da TELA inteira.' });
    expect(screen.getByText('Vai junto da TELA inteira.')).toBeTruthy();
    cleanup();
    montar({ opcao: 'nenhum', avisoDoSistema: 'Vai junto da TELA inteira.' });
    expect(screen.queryByText('Vai junto da TELA inteira.')).toBeNull();
  });
});

describe('SeletorDeSom: o jogo', () => {
  it('a lista só aparece com "só o jogo" escolhido', () => {
    montar();
    expect(screen.queryByText('PROGRAMAS COM SOM')).toBeNull();
    cleanup();
    montar({ opcao: 'jogo' });
    expect(screen.getByText('PROGRAMAS COM SOM')).toBeTruthy();
  });

  it('cada app mostra nome, se está tocando, e ícone ou a inicial', () => {
    montar({ opcao: 'jogo' });
    const mine = screen.getByRole('radio', { name: /Minecraft/ });
    expect(mine.textContent).toContain('TOCANDO');
    expect(mine.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
    const disc = screen.getByRole('radio', { name: /Discord/ });
    expect(disc.textContent).toContain('EM SILÊNCIO');
    expect(disc.textContent).toContain('D');
  });

  it('escolher um app, setas entre apps e ATUALIZAR', () => {
    const { aoEscolherApp, aoAtualizar } = montar({ opcao: 'jogo', appEscolhido: 'pid:10' });
    expect(screen.getByRole('radio', { name: /Minecraft/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: /Discord/ }));
    expect(aoEscolherApp).toHaveBeenLastCalledWith('pid:20');
    fireEvent.keyDown(screen.getByRole('radio', { name: /Minecraft/ }), { key: 'ArrowDown' });
    expect(aoEscolherApp).toHaveBeenLastCalledWith('pid:20');
    fireEvent.click(screen.getByRole('button', { name: 'ATUALIZAR' }));
    expect(aoAtualizar).toHaveBeenCalled();
  });

  it('sem nada escolhido o primeiro app é a entrada do Tab', () => {
    montar({ opcao: 'jogo' });
    const apps = screen.getAllByRole('radio').filter((r) => /Minecraft|Discord/.test(r.textContent ?? ''));
    expect(apps.map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1']);
  });

  it('estados vazios: procurando e nenhum programa', () => {
    montar({ opcao: 'jogo', apps: [], listando: true });
    expect(screen.getByText('PROCURANDO…')).toBeTruthy();
    cleanup();
    montar({ opcao: 'jogo', apps: [], listando: false });
    expect(screen.getByText(/Nenhum programa com som/)).toBeTruthy();
  });

  it('com "só o jogo" indisponível não há lista', () => {
    montar({ opcao: 'jogo', jogoDisponivel: false, motivoDoJogo: 'x' });
    expect(screen.queryByText('PROGRAMAS COM SOM')).toBeNull();
  });
});

describe('SeletorDeSom: o modo real', () => {
  it('fica num status, com o rótulo por extenso', () => {
    montar({ real: { rotulo: 'SÓ O JOGO · Minecraft', tom: 'ok' } });
    const status = screen.getByRole('status');
    expect(status.textContent).toContain('VAI SAIR');
    expect(status.textContent).toContain('SÓ O JOGO · Minecraft');
  });

  it('quando difere do escolhido, o alerta tem "!" e não depende só da cor', () => {
    montar({ real: { rotulo: 'SEM SOM · o jogo fechou', tom: 'alerta' } });
    expect(screen.getByRole('status').textContent).toContain('! SEM SOM · o jogo fechou');
  });
});

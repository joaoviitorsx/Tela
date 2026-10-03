// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DialogoAjustes } from './DialogoAjustes.js';
import type { AjustesDesktop, EstadoDaAtualizacao } from './ponte.js';

afterEach(cleanup);

const AJUSTES: AjustesDesktop = {
  iniciarComSistema: false,
  fecharEmSegundoPlano: false,
  sempreNoTopoNoCompacto: false,
  aoFecharAoVivo: 'perguntar',
  atualizarAutomaticamente: true,
  painelSobreOJogo: false,
  cantoDoPainel: 'sup-dir',
  taxaConstante: false,
  economiaParada: false,
};

const ATUALIZACAO: EstadoDaAtualizacao = {
  modo: 'automatica',
  fase: 'em-dia',
  versaoNova: null,
  progresso: null,
  ultimaVerificacaoMs: null,
  erro: null,
  adiada: false,
  podeVerificar: true,
  podeReiniciar: false,
  pagina: null,
};

function montarAtualizacao(estado: EstadoDaAtualizacao | null) {
  const aoVerificar = vi.fn();
  const aoReiniciar = vi.fn();
  const aoAbrirPagina = vi.fn();
  render(
    <DialogoAjustes
      dialogRef={createRef<HTMLDialogElement>()}
      aoClicarNoFundo={() => undefined}
      ajustes={AJUSTES}
      bandeja
      autostartFalhou={false}
      aoMudar={() => undefined}
      fecharRef={createRef<HTMLButtonElement>()}
      aoFechar={() => undefined}
      atualizacao={{ versao: '0.1.0-beta.6', estado, aoVerificar, aoReiniciar, aoAbrirPagina }}
    />,
  );
  return { aoVerificar, aoReiniciar, aoAbrirPagina };
}

function montar(sobre: { ajustes?: AjustesDesktop | null; bandeja?: boolean; autostartFalhou?: boolean } = {}) {
  const aoMudar = vi.fn();
  render(
    <DialogoAjustes
      dialogRef={createRef<HTMLDialogElement>()}
      aoClicarNoFundo={() => undefined}
      ajustes={sobre.ajustes === undefined ? AJUSTES : sobre.ajustes}
      bandeja={sobre.bandeja ?? true}
      autostartFalhou={sobre.autostartFalhou ?? false}
      aoMudar={aoMudar}
      fecharRef={createRef<HTMLButtonElement>()}
      aoFechar={() => undefined}
    />,
  );
  return aoMudar;
}

describe('DialogoAjustes', () => {
  it('três chaves, cada uma com rótulo associado (acessível por nome) que grava na hora', () => {
    const aoMudar = montar();
    fireEvent.click(screen.getByLabelText('Iniciar com o sistema'));
    fireEvent.click(screen.getByLabelText('Fechar a janela mantém o Tela em segundo plano'));
    fireEvent.click(screen.getByLabelText('Janela compacta sempre no topo'));
    expect(aoMudar).toHaveBeenNthCalledWith(1, { iniciarComSistema: true });
    expect(aoMudar).toHaveBeenNthCalledWith(2, { fecharEmSegundoPlano: true });
    expect(aoMudar).toHaveBeenNthCalledWith(3, { sempreNoTopoNoCompacto: true });
  });
  it('"Atualizar automaticamente" vem ligada e grava na hora', () => {
    const aoMudar = montar();
    const caixa = screen.getByLabelText('Atualizar automaticamente') as HTMLInputElement;
    expect(caixa.checked).toBe(true);
    fireEvent.click(caixa);
    expect(aoMudar).toHaveBeenCalledWith({ atualizarAutomaticamente: false });
  });
  it('a descrição de cada chave é lida junto (aria-describedby)', () => {
    montar();
    const caixa = screen.getByLabelText('Iniciar com o sistema');
    const id = caixa.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(id)?.textContent).toMatch(/Nunca começa a transmitir sozinho/);
  });
  it('sem bandeja, "fechar = segundo plano" fica desabilitado e explica por quê', () => {
    montar({ ajustes: { ...AJUSTES, fecharEmSegundoPlano: true }, bandeja: false });
    const caixa = screen.getByLabelText('Fechar a janela mantém o Tela em segundo plano') as HTMLInputElement;
    expect(caixa.disabled).toBe(true);
    expect(caixa.checked).toBe(false);
    expect(document.body.textContent).toMatch(/não tem ícone de bandeja/);
  });
  it('antes de o main responder, as chaves ficam travadas', () => {
    montar({ ajustes: null });
    expect((screen.getByLabelText('Iniciar com o sistema') as HTMLInputElement).disabled).toBe(true);
  });
  it('autostart que falhou é dito, e a resposta lembrada pode ser desfeita', () => {
    const aoMudar = montar({ autostartFalhou: true, ajustes: { ...AJUSTES, aoFecharAoVivo: 'segundo-plano' } });
    expect(screen.getByRole('alert', { hidden: true }).textContent).toMatch(/Nada foi alterado/);
    fireEvent.click(screen.getByRole('button', { name: 'PERGUNTAR DE NOVO', hidden: true }));
    expect(aoMudar).toHaveBeenCalledWith({ aoFecharAoVivo: 'perguntar' });
  });

  describe('atualização (D5)', () => {
    it('mostra a versão, o estado e a última verificação; VERIFICAR AGORA pede ao main', () => {
      const { aoVerificar } = montarAtualizacao({ ...ATUALIZACAO, ultimaVerificacaoMs: null });
      expect(document.body.textContent).toMatch(/Versão 0\.1\.0-beta\.6/);
      expect(screen.getByRole('status', { hidden: true }).textContent).toBe('Em dia.');
      expect(document.body.textContent).toMatch(/Última verificação: nunca/);
      fireEvent.click(screen.getByRole('button', { name: 'VERIFICAR AGORA', hidden: true }));
      expect(aoVerificar).toHaveBeenCalledTimes(1);
    });
    it('baixando: porcentagem no texto e na barra, e verificar travado', () => {
      montarAtualizacao({
        ...ATUALIZACAO,
        fase: 'baixando',
        versaoNova: '0.1.0-beta.7',
        progresso: 42,
        podeVerificar: false,
      });
      expect(screen.getByRole('status', { hidden: true }).textContent).toBe('Baixando 0.1.0-beta.7 42%');
      expect(screen.getByLabelText('Progresso do download').getAttribute('value')).toBe('42');
      expect((screen.getByRole('button', { name: 'VERIFICAR AGORA', hidden: true }) as HTMLButtonElement).disabled).toBe(true);
    });
    it('pronta e fora do ar: oferece REINICIAR E ATUALIZAR; ao vivo não oferece', () => {
      const pronta = { ...ATUALIZACAO, fase: 'pronta' as const, versaoNova: '0.1.0-beta.7' };
      const { aoReiniciar } = montarAtualizacao({ ...pronta, podeReiniciar: true });
      fireEvent.click(screen.getByRole('button', { name: 'REINICIAR E ATUALIZAR', hidden: true }));
      expect(aoReiniciar).toHaveBeenCalledTimes(1);
      cleanup();
      montarAtualizacao({ ...pronta, podeReiniciar: false });
      expect(screen.queryByRole('button', { name: 'REINICIAR E ATUALIZAR', hidden: true })).toBeNull();
      expect(document.body.textContent).toMatch(/instala quando você sair/);
    });
    it('erro aparece como texto, sem diálogo', () => {
      montarAtualizacao({ ...ATUALIZACAO, fase: 'erro', erro: 'net::ERR_INTERNET_DISCONNECTED' });
      expect(screen.getByRole('status', { hidden: true }).textContent).toMatch(/Não deu para atualizar: net::ERR/);
      expect(screen.queryByRole('alert', { hidden: true })).toBeNull();
    });
    it('deb/rpm: avisa e abre a página do pacote', () => {
      const { aoAbrirPagina } = montarAtualizacao({
        ...ATUALIZACAO,
        modo: 'avisar',
        fase: 'disponivel',
        versaoNova: '0.1.0-beta.7',
        pagina: 'https://github.com/joaoviitorsx/Tela/releases/tag/desktop-v0.1.0-beta.7',
      });
      expect(document.body.textContent).toMatch(/não se atualiza sozinho/);
      fireEvent.click(screen.getByRole('button', { name: 'ABRIR PÁGINA', hidden: true }));
      expect(aoAbrirPagina).toHaveBeenCalledWith('https://github.com/joaoviitorsx/Tela/releases/tag/desktop-v0.1.0-beta.7');
    });
    it('desligada (fora do pacote): só a versão e o motivo, sem botões de atualizar', () => {
      montarAtualizacao({ ...ATUALIZACAO, modo: 'desligada', fase: 'desligada', podeVerificar: false });
      expect(screen.queryByRole('button', { name: 'VERIFICAR AGORA', hidden: true })).toBeNull();
      expect(document.body.textContent).toMatch(/indisponível nesta execução/);
    });
    it('sem estado ainda, mostra só a versão', () => {
      montarAtualizacao(null);
      expect(document.body.textContent).toMatch(/Versão 0\.1\.0-beta\.6/);
      expect(screen.queryByRole('status', { hidden: true })).toBeNull();
    });
  });

  it('painel sobre o jogo: liga e escolhe o canto', () => {
    const desligado = montar();
    fireEvent.click(screen.getByLabelText('Painel sobre o jogo'));
    expect(desligado).toHaveBeenCalledWith({ painelSobreOJogo: true });
    expect(screen.queryByRole('button', { name: '↙ BAIXO', hidden: true })).toBeNull();
    cleanup();
    const ligado = montar({ ajustes: { ...AJUSTES, painelSobreOJogo: true } });
    fireEvent.click(screen.getByRole('button', { name: '↙ BAIXO', hidden: true }));
    expect(ligado).toHaveBeenCalledWith({ cantoDoPainel: 'inf-esq' });
  });
});

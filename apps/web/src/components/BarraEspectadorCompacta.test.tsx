// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PropsDaBarra } from './BarraEspectador.js';
import { BarraEspectadorCompacta } from './BarraEspectadorCompacta.js';

afterEach(cleanup);

function props(sobre: Partial<PropsDaBarra> = {}): PropsDaBarra {
  return {
    canal: 'jv',
    viewers: 2,
    reconectando: false,
    latencia: '68 ms',
    latenciaAlta: false,
    latenciaTitulo: 'rede 20 ms',
    imagem: '1920×1080',
    travado: null,
    avisoAudio: null,
    avisoImagem: null,
    temAudio: true,
    volume: { valor: 1, mudo: false, ajustavel: true, passo: 0.05, aoAjustar: vi.fn(), aoAlternar: vi.fn(), aoAtivar: vi.fn(), deslizanteNaCompacta: false },
    zoom: { porcento: '100%', ampliado: false, aoAumentar: vi.fn(), aoDiminuir: vi.fn(), aoResetar: vi.fn() },
    aoEsconder: vi.fn(),
    pip: { ativo: false, aoAlternar: vi.fn() },
    emTelaCheia: false,
    aoTelaCheia: vi.fn(),
    copiouDiagnostico: false,
    aoCopiarDiagnostico: vi.fn(),
    abrirNoApp: null,
    ...sobre,
  };
}

describe('BarraEspectadorCompacta', () => {
  it('uma linha com o essencial: AO VIVO, quantos, latência, som e tela cheia', () => {
    render(<BarraEspectadorCompacta {...props()} />);
    expect(screen.getByText('AO VIVO')).toBeTruthy();
    expect(screen.getByLabelText('2 pessoas assistindo')).toBeTruthy();
    expect(screen.getByText('68 ms')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Silenciar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tela cheia (F)' })).toBeTruthy();
  });

  it('zoom, picture-in-picture e esconder ficam atrás de ⋯', () => {
    render(<BarraEspectadorCompacta {...props()} />);
    expect(screen.queryByRole('button', { name: /Aumentar zoom/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Picture-in-picture/ })).toBeNull();

    const mais = screen.getByRole('button', { name: 'Mais controles' });
    expect(mais.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(mais);
    expect(mais.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /Aumentar zoom/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Picture-in-picture/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Esconder controles/ })).toBeTruthy();
  });

  it('os botões chamam os mesmos callbacks da barra cheia', () => {
    const p = props();
    render(<BarraEspectadorCompacta {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Silenciar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tela cheia (F)' }));
    expect(p.volume.aoAlternar).toHaveBeenCalledTimes(1);
    expect(p.aoTelaCheia).toHaveBeenCalledTimes(1);
  });

  it('reconectando troca o selo e sem áudio não há botão de som', () => {
    render(<BarraEspectadorCompacta {...props({ reconectando: true, temAudio: false })} />);
    expect(screen.getByText('RECONECTANDO')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Silenciar' })).toBeNull();
  });
});

describe('BarraEspectadorCompacta — volume', () => {
  it('com mouse (janela baixa no PC) vai o deslizante, não só o mudo', () => {
    const p = props();
    render(<BarraEspectadorCompacta {...p} volume={{ ...p.volume, deslizanteNaCompacta: true }} />);
    expect(screen.getByRole('slider', { name: 'Volume da transmissão' })).toBeTruthy();
  });

  it('transmissão sem som: o controle fica à vista, dizendo por quê', () => {
    render(<BarraEspectadorCompacta {...props({ temAudio: false })} />);
    expect(screen.getByText('SEM SOM')).toBeTruthy();
    expect(screen.queryByRole('slider')).toBeNull();
  });
});

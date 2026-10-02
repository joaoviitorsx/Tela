import { describe, expect, it, vi } from 'vitest';
import { err, ok } from '../core/domain/result.js';
import type { CaptureRequest, CaptureResult, ScreenCapture } from '../core/ports/screen-capture.js';
import type { EscolhaDeSom } from './som-desktop.js';
import { comSomEscolhido } from './som-na-captura.js';

const PEDIDO: CaptureRequest = { width: 1920, height: 1080, frameRate: 60, systemAudio: true };
const video = {} as MediaStreamTrack;
const audio = {} as MediaStreamTrack;

function montar(escolha: EscolhaDeSom, resultado: CaptureResult | 'negado' = { video, audio, surface: 'monitor' }) {
  const request = vi.fn(() => Promise.resolve(resultado === 'negado' ? err('DENIED' as const) : ok(resultado)));
  const tela: ScreenCapture = { isSupported: () => true, request };
  const registrar = vi.fn();
  return { tela: comSomEscolhido(tela, { escolhaAtual: () => escolha, registrar }), request, registrar };
}

describe('comSomEscolhido', () => {
  it('Sistema pede áudio à tela e registra que veio', async () => {
    const { tela, request, registrar } = montar({ tipo: 'sistema' });
    await tela.request(PEDIDO);
    expect(request).toHaveBeenCalledWith({ ...PEDIDO, systemAudio: true });
    expect(registrar).toHaveBeenCalledWith({ situacao: 'ativo' });
  });

  it.each([[{ tipo: 'jogo', appId: 'pid:1', nome: 'X' } as const], [{ tipo: 'nenhum' } as const]])('%j NÃO pede áudio à tela: a call não pode vir junto', async (escolha) => {
    const { tela, request, registrar } = montar(escolha, { video, audio: null, surface: 'monitor' });
    await tela.request(PEDIDO);
    expect(request).toHaveBeenCalledWith({ ...PEDIDO, systemAudio: false });
    expect(registrar).not.toHaveBeenCalled();
  });

  it('"só o jogo" e "sem som" numa janela não disparam o aviso de "sem áudio": a superfície vira desconhecida', async () => {
    for (const escolha of [{ tipo: 'jogo', appId: 'pid:1', nome: 'X' } as const, { tipo: 'nenhum' } as const]) {
      const { tela } = montar(escolha, { video, audio: null, surface: 'window' });
      const r = await tela.request(PEDIDO);
      expect(r.ok && r.value.surface).toBe('desconhecido');
    }
  });

  it('no Sistema a superfície segue verdadeira: janela sem som continua avisando', async () => {
    const { tela } = montar({ tipo: 'sistema' }, { video, audio: null, surface: 'window' });
    const r = await tela.request(PEDIDO);
    expect(r.ok && r.value.surface).toBe('window');
  });

  it('Sistema numa janela (sem áudio): não registra nada — o adapter de áudio diz o motivo', async () => {
    const { tela, registrar } = montar({ tipo: 'sistema' }, { video, audio: null, surface: 'window' });
    await tela.request(PEDIDO);
    expect(registrar).not.toHaveBeenCalled();
  });

  it('respeita um pedido que já não queria áudio e repassa o erro', async () => {
    const { tela, request } = montar({ tipo: 'sistema' }, 'negado');
    const r = await tela.request({ ...PEDIDO, systemAudio: false });
    expect(request).toHaveBeenCalledWith({ ...PEDIDO, systemAudio: false });
    expect(r.ok).toBe(false);
  });

  it('repassa isSupported', () => {
    expect(montar({ tipo: 'sistema' }).tela.isSupported()).toBe(true);
  });
});

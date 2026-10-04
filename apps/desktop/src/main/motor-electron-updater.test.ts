import { describe, expect, it, vi } from 'vitest';
import { criarMotorDoUpdater, type ModuloDoUpdater } from './motor-electron-updater.js';

const LISTA = JSON.stringify([
  { tag_name: 'desktop-v0.1.0-beta.6', draft: false, prerelease: true },
  { tag_name: 'desktop-v0.1.0-beta.7', draft: false, prerelease: true },
]);

/** O recorte do `electron-updater` que o motor usa, no lugar do verdadeiro. */
function updaterFalso(sobre: { disponivel?: boolean; falhaNoDownload?: Error } = {}) {
  const ouvintes = new Map<string, (i: { percent: number }) => void>();
  class Token {
    cancelled = false;
    cancel() {
      this.cancelled = true;
    }
  }
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    allowDowngrade: true,
    allowPrerelease: false,
    logger: null as unknown,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => ({
      isUpdateAvailable: sobre.disponivel ?? true,
      updateInfo: { version: '0.1.0-beta.7' },
    })),
    downloadUpdate: vi.fn(async (token: Token) => {
      ouvintes.get('download-progress')?.({ percent: 50 });
      if (sobre.falhaNoDownload !== undefined) throw sobre.falhaNoDownload;
      if (token.cancelled) throw new Error('cancelled');
      return ['/tmp/Tela-0.1.0-beta.7-linux-x86_64.AppImage'];
    }),
    on: vi.fn((nome: string, fn: (i: { percent: number }) => void) => ouvintes.set(nome, fn)),
    removeListener: vi.fn((nome: string) => ouvintes.delete(nome)),
    quitAndInstall: vi.fn(),
  };
  return { autoUpdater, Token, modulo: { autoUpdater, CancellationToken: Token } as unknown as ModuloDoUpdater };
}

function montar(
  modo: 'automatica' | 'avisar',
  versaoAtual = '0.1.0-beta.6',
  f = updaterFalso(),
  assinatura: { confere?: boolean; sig?: Uint8Array | null; arquivo?: Uint8Array | null } = {},
) {
  const carregarUpdater = vi.fn(async () => f.modulo);
  const aoReiniciar = vi.fn();
  const baixarBinario = vi.fn(async () => (assinatura.sig === undefined ? new Uint8Array([1]) : assinatura.sig));
  const lerArquivo = vi.fn(async () => (assinatura.arquivo === undefined ? new Uint8Array([2]) : assinatura.arquivo));
  const verificarAssinatura = vi.fn(() => assinatura.confere ?? true);
  const motor = criarMotorDoUpdater({
    modo,
    versaoAtual,
    buscarLista: async () => LISTA,
    baixarBinario,
    lerArquivo,
    verificarAssinatura,
    carregarUpdater,
    aoReiniciar,
    log: { info: () => undefined, erro: () => undefined },
  });
  return { motor, f, carregarUpdater, aoReiniciar, baixarBinario, lerArquivo, verificarAssinatura };
}

describe('motor sobre o electron-updater (mockado)', () => {
  it('aponta o provider generic para a pasta da tag com prefixo e usa a política: sem download nem instalação automáticos', async () => {
    const { motor, f } = montar('automatica');
    expect(await motor.verificar()).toEqual({
      versao: '0.1.0-beta.7',
      pagina: 'https://github.com/joaoviitorsx/Tela/releases/tag/desktop-v0.1.0-beta.7',
    });
    expect(f.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://github.com/joaoviitorsx/Tela/releases/download/desktop-v0.1.0-beta.7/',
    });
    expect(f.autoUpdater).toMatchObject({
      autoDownload: false,
      // `true` no setup para o electron-updater registrar o gancho de sair no fim
      // do download; a assinatura (ADR 0038) religa p/ false até verificar. A
      // trava real está em `conferirAssinatura`/`instalarAoSair`, testada abaixo.
      autoInstallOnAppQuit: true,
      allowDowngrade: false,
      allowPrerelease: true,
    });
  });

  it('em dia: nem chega a carregar o updater', async () => {
    const { motor, carregarUpdater } = montar('automatica', '0.1.0-beta.7');
    expect(await motor.verificar()).toBeNull();
    expect(carregarUpdater).not.toHaveBeenCalled();
  });

  it('o updater tem a palavra final: o latest.yml diz que não há versão nova', async () => {
    const { motor } = montar('automatica', '0.1.0-beta.6', updaterFalso({ disponivel: false }));
    expect(await motor.verificar()).toBeNull();
  });

  it('deb/rpm: avisa sem carregar o electron-updater', async () => {
    const { motor, carregarUpdater } = montar('avisar');
    expect((await motor.verificar())?.versao).toBe('0.1.0-beta.7');
    expect(carregarUpdater).not.toHaveBeenCalled();
  });

  it('baixa repassando o progresso e devolve a versão', async () => {
    const { motor, f } = montar('automatica');
    await motor.verificar();
    const p = vi.fn();
    expect(await motor.baixar(p)).toBe('0.1.0-beta.7');
    expect(p).toHaveBeenCalledWith(50);
    expect(f.autoUpdater.removeListener).toHaveBeenCalled();
  });

  it('falha do download propaga; cancelar não é falha (devolve null)', async () => {
    const falha = montar('automatica', '0.1.0-beta.6', updaterFalso({ falhaNoDownload: new Error('sha512 não confere') }));
    await falha.motor.verificar();
    await expect(falha.motor.baixar(() => undefined)).rejects.toThrow('sha512');

    const { motor, f } = montar('automatica');
    await motor.verificar();
    f.autoUpdater.downloadUpdate.mockImplementationOnce(async (token) => {
      motor.cancelarDownload();
      void token;
      throw new Error('cancelled');
    });
    expect(await motor.baixar(() => undefined)).toBeNull();
  });

  it('reiniciar avisa o main (para a janela deixar sair) e instala em silêncio, reabrindo o app', async () => {
    const { motor, f, aoReiniciar } = montar('automatica');
    await motor.verificar();
    await motor.baixar(() => undefined); // só depois de baixar+verificar o install destrava
    motor.instalarAoSair(true);
    expect(f.autoUpdater.autoInstallOnAppQuit).toBe(true);
    motor.instalarAoSair(false);
    expect(f.autoUpdater.autoInstallOnAppQuit).toBe(false);
    motor.instalarAgora();
    expect(aoReiniciar).toHaveBeenCalledTimes(1);
    expect(f.autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  describe('assinatura do update (ADR 0038)', () => {
    it('confere: baixa, verifica o .sig do instalador e libera a instalação', async () => {
      const { motor, f, baixarBinario, verificarAssinatura } = montar('automatica');
      await motor.verificar();
      expect(await motor.baixar(() => undefined)).toBe('0.1.0-beta.7');
      // o .sig foi buscado na URL do instalador + ".sig", na pasta da release
      expect(baixarBinario).toHaveBeenCalledWith(
        'https://github.com/joaoviitorsx/Tela/releases/download/desktop-v0.1.0-beta.7/Tela-0.1.0-beta.7-linux-x86_64.AppImage.sig',
      );
      expect(verificarAssinatura).toHaveBeenCalled();
      motor.instalarAoSair(true);
      expect(f.autoUpdater.autoInstallOnAppQuit).toBe(true);
    });

    it('NÃO confere: baixar rejeita, nada instala ao sair, e instalarAgora é recusado', async () => {
      const { motor, f, aoReiniciar } = montar('automatica', '0.1.0-beta.6', updaterFalso(), { confere: false });
      await motor.verificar();
      await expect(motor.baixar(() => undefined)).rejects.toThrow('assinatura');
      expect(f.autoUpdater.autoInstallOnAppQuit).toBe(false);
      motor.instalarAoSair(true);
      expect(f.autoUpdater.autoInstallOnAppQuit).toBe(false); // nem a política liga sem assinatura
      motor.instalarAgora();
      expect(aoReiniciar).not.toHaveBeenCalled();
      expect(f.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });

    it('.sig ausente no release: baixar rejeita (fail-closed)', async () => {
      const { motor } = montar('automatica', '0.1.0-beta.6', updaterFalso(), { sig: null });
      await motor.verificar();
      await expect(motor.baixar(() => undefined)).rejects.toThrow(/assinatura.*ausente|ausente/);
    });
  });
});

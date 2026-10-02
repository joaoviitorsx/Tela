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
      return ['x'];
    }),
    on: vi.fn((nome: string, fn: (i: { percent: number }) => void) => ouvintes.set(nome, fn)),
    removeListener: vi.fn((nome: string) => ouvintes.delete(nome)),
    quitAndInstall: vi.fn(),
  };
  return { autoUpdater, Token, modulo: { autoUpdater, CancellationToken: Token } as unknown as ModuloDoUpdater };
}

function montar(modo: 'automatica' | 'avisar', versaoAtual = '0.1.0-beta.6', f = updaterFalso()) {
  const carregarUpdater = vi.fn(async () => f.modulo);
  const aoReiniciar = vi.fn();
  const motor = criarMotorDoUpdater({
    modo,
    versaoAtual,
    buscarLista: async () => LISTA,
    carregarUpdater,
    aoReiniciar,
    log: { info: () => undefined, erro: () => undefined },
  });
  return { motor, f, carregarUpdater, aoReiniciar };
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
      autoInstallOnAppQuit: true, // o gancho de sair só nasce com um download concluído
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
    motor.instalarAoSair(true);
    expect(f.autoUpdater.autoInstallOnAppQuit).toBe(true);
    motor.instalarAoSair(false);
    expect(f.autoUpdater.autoInstallOnAppQuit).toBe(false);
    motor.instalarAgora();
    expect(aoReiniciar).toHaveBeenCalledTimes(1);
    expect(f.autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });
});

import { describe, expect, it } from 'vitest';
import { bandejaForcada, COMANDO_DA_SONDA, plataformaTemBandeja, watcherPresenteNaSaida } from './bandeja.js';

describe('bandeja', () => {
  it('lê a resposta do dbus-send', () => {
    expect(watcherPresenteNaSaida('method return time=1 sender=:1.4 -> destination=:1.99 serial=3 reply_serial=2\n   boolean true\n')).toBe(true);
    expect(watcherPresenteNaSaida('   boolean false\n')).toBe(false);
    expect(watcherPresenteNaSaida('')).toBe(false);
    expect(watcherPresenteNaSaida('Error org.freedesktop.DBus.Error.ServiceUnknown')).toBe(false);
  });
  it('a sonda pergunta pelo dono do watcher no barramento de sessão', () => {
    expect(COMANDO_DA_SONDA.args).toContain('--session');
    expect(COMANDO_DA_SONDA.args.join(' ')).toContain('NameHasOwner string:org.kde.StatusNotifierWatcher');
  });
  it('TELA_BANDEJA força a resposta', () => {
    expect(bandejaForcada({ TELA_BANDEJA: '0' })).toBe(false);
    expect(bandejaForcada({ TELA_BANDEJA: '1' })).toBe(true);
    expect(bandejaForcada({})).toBeNull();
    expect(bandejaForcada({ TELA_BANDEJA: 'talvez' })).toBeNull();
  });
  it('só o Linux precisa sondar', () => {
    expect(plataformaTemBandeja('win32')).toBe(true);
    expect(plataformaTemBandeja('linux')).toBe('sondar');
  });
});

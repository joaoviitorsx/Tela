import { describe, expect, it } from 'vitest';
import { ambienteEfetivo } from './ambiente.js';
import { deveRegistrarEsquema } from './link-profundo.js';
import { origensPermitidas } from './seguranca.js';

const SUJO = {
  TELA_DESKTOP_URL: 'http://evil.example/',
  TELA_USERDATA: '/tmp/evil',
  TELA_NATIVO: '1',
  TELA_BANDEJA: 'sim',
  TELA_REGISTRAR_ESQUEMA: '1',
  TELA_QUALQUER: 'x',
  HOME: '/home/u',
  XDG_SESSION_TYPE: 'wayland',
} as const;

describe('ambiente efetivo (S-11)', () => {
  it('fora do pacote, nada muda (e2e e dev usam o ambiente inteiro)', () => {
    expect(ambienteEfetivo(SUJO, false)).toBe(SUJO);
  });

  it('empacotado, ignora TELA_DESKTOP_URL, TELA_USERDATA e o resto de TELA_*, e mantém o ambiente do sistema', () => {
    const e = ambienteEfetivo(SUJO, true);
    expect(e['TELA_DESKTOP_URL']).toBeUndefined();
    expect(e['TELA_USERDATA']).toBeUndefined();
    expect(e['TELA_QUALQUER']).toBeUndefined();
    expect(e['TELA_NATIVO']).toBeUndefined();
    expect(e['TELA_BANDEJA']).toBeUndefined();
    expect(e['TELA_REGISTRAR_ESQUEMA']).toBeUndefined();
    expect(e['HOME']).toBe('/home/u');
    expect(e['XDG_SESSION_TYPE']).toBe('wayland');
  });

  it('empacotado, o subconjunto que só reduz capacidade passa', () => {
    const e = ambienteEfetivo({ TELA_NATIVO: '0', TELA_REGISTRAR_ESQUEMA: '0', TELA_BANDEJA: '1' }, true);
    expect(e).toEqual({ TELA_NATIVO: '0', TELA_REGISTRAR_ESQUEMA: '0', TELA_BANDEJA: '1' });
  });

  it('o app empacotado nunca abre a origem de TELA_DESKTOP_URL nem força o registro do esquema', () => {
    const e = ambienteEfetivo(SUJO, true);
    const origens = origensPermitidas(e['TELA_DESKTOP_URL']);
    expect([...origens]).toEqual(['app://tela']);
    expect(deveRegistrarEsquema(true, e)).toBe(true); // o padrão do empacotado
    expect(deveRegistrarEsquema(false, e)).toBe(false); // o `=1` do ambiente não chegou: não força
  });
});

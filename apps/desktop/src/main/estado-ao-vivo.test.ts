import { describe, expect, it } from 'vitest';
import { type EstadoDaAtualizacao } from './atualizacao-politica.js';
import {
  estadoAoVivoValido,
  FORA_DO_AR,
  itemDeAtualizacao,
  mesmoEstado,
  modeloDoMenu,
  rotuloDoEstado,
  tempoNoAr,
} from './estado-ao-vivo.js';

const NO_AR = { noAr: true, inicioMs: 1_000_000, assistindo: 3, capacidade: 50, link: 'https://tela.gg/jv', oculto: false };

describe('estadoAoVivoValido', () => {
  it('aceita um estado ao vivo completo', () => {
    expect(estadoAoVivoValido(NO_AR)).toEqual({ ...NO_AR, link: 'https://tela.gg/jv' });
  });
  it('fora do ar vira FORA_DO_AR, sem herdar lixo', () => {
    expect(estadoAoVivoValido({ ...NO_AR, noAr: false })).toBe(FORA_DO_AR);
  });
  it('recusa o que não é estado', () => {
    for (const ruim of [null, undefined, 'x', 3, [], {}, { noAr: 'sim' }]) expect(estadoAoVivoValido(ruim)).toBeNull();
  });
  it('recusa números fora de faixa ou não inteiros', () => {
    for (const campo of ['assistindo', 'capacidade'] as const) {
      for (const v of [-1, 1.5, NaN, Infinity, 1001, '3', null]) {
        expect(estadoAoVivoValido({ ...NO_AR, [campo]: v })).toBeNull();
      }
    }
    for (const v of [0, -5, NaN, '1', Infinity]) expect(estadoAoVivoValido({ ...NO_AR, inicioMs: v })).toBeNull();
  });
  it('inicioMs e link podem ser null; link só http(s) — é só copiado, nunca aberto', () => {
    expect(estadoAoVivoValido({ ...NO_AR, inicioMs: null, link: null })).toMatchObject({ inicioMs: null, link: null });
    expect(estadoAoVivoValido({ ...NO_AR, link: 'http://localhost:5173/jv' })?.link).toBe('http://localhost:5173/jv');
    for (const l of ['ftp://tela.gg/jv', 'javascript:alert(1)', 'file:///etc/passwd', 'app://tela/x', 7, `https://x/${'a'.repeat(3000)}`]) {
      expect(estadoAoVivoValido({ ...NO_AR, link: l })).toBeNull();
    }
  });
  it('mesmoEstado só é verdadeiro para estados iguais', () => {
    expect(mesmoEstado(NO_AR, { ...NO_AR })).toBe(true);
    expect(mesmoEstado(NO_AR, { ...NO_AR, assistindo: 4 })).toBe(false);
    expect(mesmoEstado(NO_AR, { ...NO_AR, oculto: true })).toBe(false);
    expect(mesmoEstado(FORA_DO_AR, FORA_DO_AR)).toBe(true);
  });
});

describe('rótulos e menu', () => {
  it('tempo mm:ss e h:mm:ss', () => {
    expect(tempoNoAr(1_000_000, 1_042_000)).toBe('00:42');
    expect(tempoNoAr(0 + 1, 1 + 3_725_000)).toBe('1:02:05');
    expect(tempoNoAr(null, 5)).toBe('--:--');
    expect(tempoNoAr(5000, 1000)).toBe('00:00');
  });
  it('o estado em uma linha', () => {
    expect(rotuloDoEstado(NO_AR, 1_042_000)).toBe('NO AR 00:42 · 3/50');
    expect(rotuloDoEstado(FORA_DO_AR, 0)).toBe('Fora do ar');
  });
  it('fora do ar: copiar e encerrar desabilitados', () => {
    const itens = modeloDoMenu(FORA_DO_AR, true, 0).filter((i) => i.tipo === 'item');
    const por = (id: string) => itens.find((i) => i.id === id);
    expect(por('copiar')?.habilitado).toBe(false);
    expect(por('encerrar')?.habilitado).toBe(false);
    expect(por('mostrar')?.rotulo).toBe('Esconder');
    expect(por('sair')?.rotulo).toBe('Sair');
  });
  it('ao vivo e escondida: copiar, encerrar e Mostrar', () => {
    const itens = modeloDoMenu(NO_AR, false, 1_042_000).filter((i) => i.tipo === 'item');
    const por = (id: string) => itens.find((i) => i.id === id);
    expect(por('estado')?.rotulo).toBe('NO AR 00:42 · 3/50');
    expect(por('copiar')?.habilitado).toBe(true);
    expect(por('encerrar')?.habilitado).toBe(true);
    expect(por('mostrar')?.rotulo).toBe('Mostrar');
    expect(por('sair')?.rotulo).toMatch(/encerra a transmissão/);
  });
  it('ao vivo: ocultar ou mostrar a transmissão; fora do ar, nada', () => {
    const rotulo = (e: typeof NO_AR) =>
      modoDoItem(modeloDoMenu(e, true, 0).filter((i) => i.tipo === 'item').find((i) => i.id === 'ocultar'));
    expect(rotulo(NO_AR)).toBe('Ocultar a transmissão dos amigos');
    expect(rotulo({ ...NO_AR, oculto: true })).toBe('Mostrar a transmissão aos amigos');
    expect(modeloDoMenu(FORA_DO_AR, true, 0).some((i) => i.tipo === 'item' && i.id === 'ocultar')).toBe(false);
  });
  it('renderer antigo, sem o campo: não oculto', () => {
    const { oculto: _, ...semCampo } = NO_AR;
    expect(estadoAoVivoValido(semCampo)?.oculto).toBe(false);
    expect(estadoAoVivoValido({ ...NO_AR, oculto: 'sim' })?.oculto).toBe(false);
  });
});

function modoDoItem(item: { readonly rotulo?: string } | undefined): string | undefined {
  return item?.rotulo;
}

describe('bandeja: item de atualização (D5)', () => {
  const VISTA: EstadoDaAtualizacao = {
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
  it('sem o que fazer, a bandeja é a de sempre (sem o item)', () => {
    expect(itemDeAtualizacao(VISTA)).toBeNull();
    const ids = modeloDoMenu(FORA_DO_AR, true, 0, null).flatMap((i) => (i.tipo === 'item' ? [i.id] : []));
    expect(ids).not.toContain('atualizar');
  });
  it('pronta e fora do ar: REINICIAR E ATUALIZAR habilitado, entre Mostrar e Encerrar', () => {
    const item = itemDeAtualizacao({ ...VISTA, fase: 'pronta', versaoNova: '0.1.0-beta.7', podeReiniciar: true });
    expect(item).toEqual({ rotulo: 'Reiniciar e atualizar (0.1.0-beta.7)', habilitado: true });
    const ids = modeloDoMenu(FORA_DO_AR, true, 0, item).flatMap((i) => (i.tipo === 'item' ? [i.id] : []));
    expect(ids).toEqual(['estado', 'copiar', 'mostrar', 'atualizar', 'encerrar', 'sair']);
  });
  it('pronta ao vivo: a linha aparece travada, dizendo que instala ao sair', () => {
    const item = itemDeAtualizacao({ ...VISTA, fase: 'pronta', versaoNova: '0.1.0-beta.7', podeReiniciar: false });
    expect(item?.habilitado).toBe(false);
    expect(item?.rotulo).toMatch(/instala ao sair/);
  });
  it('deb/rpm: leva à página do pacote', () => {
    const item = itemDeAtualizacao({
      ...VISTA,
      modo: 'avisar',
      fase: 'disponivel',
      versaoNova: '0.1.0-beta.7',
      pagina: 'https://github.com/joaoviitorsx/Tela/releases/tag/desktop-v0.1.0-beta.7',
    });
    expect(item).toEqual({ rotulo: 'Nova versão 0.1.0-beta.7 (abrir página)', habilitado: true });
  });
});

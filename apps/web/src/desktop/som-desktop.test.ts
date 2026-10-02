import { describe, expect, it, vi } from 'vitest';
import type { AppComSom, CapacidadesDeSom } from './ponte.js';
import { descreverReal, makeSomDesktop, pendenteDoSom } from './som-desktop.js';
import { escolhaGuardada, serializarEscolha } from './som-desktop.js';

const DISPONIVEL: CapacidadesDeSom = { jogo: { disponivel: true, motivo: null } };
const INDISPONIVEL: CapacidadesDeSom = { jogo: { disponivel: false, motivo: 'Precisa do Windows 10 versão 2004.' } };
const MINECRAFT: AppComSom = { id: 'pid:10', nome: 'Minecraft', tocando: true, icone: null };
const DISCORD: AppComSom = { id: 'pid:20', nome: 'Discord', tocando: true, icone: null };

const tudo = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function montar(opcoes: { capacidades?: CapacidadesDeSom; apps?: readonly AppComSom[]; plataforma?: 'win32' | 'linux' } = {}) {
  const agendados: Array<() => void> = [];
  const listarApps = vi.fn(() => Promise.resolve(opcoes.apps ?? [MINECRAFT, DISCORD]));
  const som = makeSomDesktop({
    plataforma: opcoes.plataforma ?? 'win32',
    capacidades: () => Promise.resolve(opcoes.capacidades ?? DISPONIVEL),
    listarApps,
    agendar: (fn) => {
      const rodar = (): void => {
        const i = agendados.indexOf(rodar);
        if (i >= 0) agendados.splice(i, 1);
        fn();
      };
      agendados.push(rodar);
      return () => {
        const i = agendados.indexOf(rodar);
        if (i >= 0) agendados.splice(i, 1);
      };
    },
  });
  return { som, listarApps, agendados };
}

describe('descreverReal: o modo REAL, por extenso', () => {
  it('sistema diz que vai tudo menos a call', () => {
    expect(descreverReal({ tipo: 'sistema' }, null, [], null)).toEqual({ rotulo: 'SISTEMA · tudo menos a call', curto: 'SISTEMA', tom: 'ok' });
    expect(descreverReal({ tipo: 'sistema' }, DISPONIVEL, [], null).rotulo).toBe('SISTEMA · tudo menos a call');
  });

  it('sistema sem o componente que separa a call: indisponível, em alerta — nunca a call no lugar', () => {
    expect(descreverReal({ tipo: 'sistema' }, INDISPONIVEL, [], null)).toEqual({ rotulo: 'SISTEMA · indisponível', curto: 'SEM SOM', tom: 'alerta' });
  });

  it('só o jogo diz qual', () => {
    const r = descreverReal({ tipo: 'jogo', appId: 'pid:10', nome: 'Minecraft' }, DISPONIVEL, [MINECRAFT], null);
    expect(r).toEqual({ rotulo: 'SÓ O JOGO · Minecraft', curto: 'SÓ O JOGO', tom: 'ok' });
  });

  it('só o jogo sem jogo escolhido pede a escolha', () => {
    expect(descreverReal({ tipo: 'jogo', appId: null, nome: null }, DISPONIVEL, [], null)).toMatchObject({ rotulo: 'SÓ O JOGO · escolha o jogo', tom: 'alerta' });
  });

  it('o jogo escolhido fechou antes de ir ao ar: avisa', () => {
    expect(descreverReal({ tipo: 'jogo', appId: 'pid:10', nome: 'Minecraft' }, DISPONIVEL, [DISCORD], null)).toMatchObject({
      rotulo: 'SÓ O JOGO · Minecraft (não está aberto)',
      tom: 'alerta',
    });
    // Sem listagem ainda não dá para afirmar nada: segue o plano.
    expect(descreverReal({ tipo: 'jogo', appId: 'pid:10', nome: 'Minecraft' }, DISPONIVEL, [], null).tom).toBe('ok');
  });

  it('só o jogo indisponível nunca vira outra coisa em silêncio', () => {
    expect(descreverReal({ tipo: 'jogo', appId: 'pid:10', nome: 'X' }, INDISPONIVEL, [], null)).toMatchObject({ rotulo: 'SÓ O JOGO · indisponível', curto: 'SEM SOM', tom: 'alerta' });
  });

  it('a captura que falhou ou parou vence o plano', () => {
    const jogo = { tipo: 'jogo', appId: 'pid:10', nome: 'Minecraft' } as const;
    expect(descreverReal(jogo, DISPONIVEL, [MINECRAFT], { situacao: 'falhou', motivo: 'o Windows recusou' })).toEqual({
      rotulo: 'SEM SOM · o Windows recusou',
      curto: 'SEM SOM',
      tom: 'alerta',
    });
    expect(descreverReal(jogo, DISPONIVEL, [MINECRAFT], { situacao: 'parou', motivo: 'o jogo fechou' }).rotulo).toBe('SEM SOM · o jogo fechou');
    expect(descreverReal({ tipo: 'sistema' }, null, [], { situacao: 'falhou', motivo: 'o som não iniciou' }).rotulo).toBe('SEM SOM · o som não iniciou');
  });

  it('sem som é sem som', () => {
    expect(descreverReal({ tipo: 'nenhum' }, null, [], { situacao: 'falhou', motivo: 'x' })).toEqual({ rotulo: 'SEM SOM', curto: 'SEM SOM', tom: 'ok' });
  });
});

describe('pendenteDoSom', () => {
  it('só uma escolha incompleta ou indisponível bloqueia', () => {
    expect(pendenteDoSom({ tipo: 'sistema' }, null)).toBeNull();
    expect(pendenteDoSom({ tipo: 'sistema' }, DISPONIVEL)).toBeNull();
    expect(pendenteDoSom({ tipo: 'sistema' }, INDISPONIVEL)).toContain('não está disponível');
    expect(pendenteDoSom({ tipo: 'nenhum' }, null)).toBeNull();
    expect(pendenteDoSom({ tipo: 'jogo', appId: null, nome: null }, DISPONIVEL)).toContain('Escolha o jogo');
    expect(pendenteDoSom({ tipo: 'jogo', appId: 'pid:1', nome: 'X' }, DISPONIVEL)).toBeNull();
    expect(pendenteDoSom({ tipo: 'jogo', appId: 'pid:1', nome: 'X' }, INDISPONIVEL)).toContain('não está disponível');
  });
});

describe('makeSomDesktop', () => {
  it('começa em SEM SOM e não pergunta nada ao main sem observador', () => {
    const { som, listarApps } = montar();
    expect(som.snapshot().escolha).toEqual({ tipo: 'nenhum' });
    expect(som.snapshot().real.rotulo).toContain('SEM SOM');
    expect(listarApps).not.toHaveBeenCalled();
  });

  it('lembra a escolha: começa nela e grava cada troca', () => {
    let guardado: string | null = 'sistema';
    const som = makeSomDesktop({
      plataforma: 'linux',
      capacidades: () => Promise.resolve({ jogo: { disponivel: true, motivo: null } }),
      listarApps: () => Promise.resolve([]),
      agendar: () => () => undefined,
      memoria: { ler: () => guardado, gravar: (v) => { guardado = v; } },
    });
    expect(som.snapshot().escolha).toEqual({ tipo: 'sistema' });
    som.escolherNenhum();
    expect(guardado).toBe('nenhum');
  });

  it('só lista apps com "só o jogo" escolhido, e só com a interface montada', async () => {
    const { som, listarApps } = montar();
    const parar = som.observar();
    await tudo();
    expect(listarApps).not.toHaveBeenCalled();
    som.escolherJogo();
    await tudo();
    expect(listarApps).toHaveBeenCalledTimes(1);
    expect(som.snapshot().apps).toEqual([MINECRAFT, DISCORD]);
    parar();
    som.escolherSistema();
    expect(som.snapshot().apps).toEqual([MINECRAFT, DISCORD]);
  });

  it('não lista quando "só o jogo" está indisponível', async () => {
    const { som, listarApps } = montar({ capacidades: INDISPONIVEL });
    som.observar();
    som.escolherJogo();
    await tudo();
    expect(listarApps).not.toHaveBeenCalled();
    expect(som.snapshot().capacidades).toEqual(INDISPONIVEL);
    expect(som.snapshot().pendente).toContain('não está disponível');
  });

  it('escolher um app define o rótulo real e libera ir ao ar', async () => {
    const { som } = montar();
    som.observar();
    som.escolherJogo();
    await tudo();
    expect(som.snapshot().pendente).toContain('Escolha o jogo');
    som.escolherApp(MINECRAFT);
    expect(som.snapshot().real.rotulo).toBe('SÓ O JOGO · Minecraft');
    expect(som.snapshot().pendente).toBeNull();
  });

  it('a lista se atualiza sozinha enquanto observada, e para ao sair', async () => {
    const { som, listarApps, agendados } = montar();
    const parar = som.observar();
    som.escolherJogo();
    await tudo();
    expect(agendados).toHaveLength(1);
    agendados[0]!();
    await tudo();
    expect(listarApps).toHaveBeenCalledTimes(2);
    parar();
    expect(agendados).toHaveLength(0);
  });

  it('o resultado da captura fica até a escolha mudar', async () => {
    const { som } = montar();
    som.observar();
    som.escolherApp(MINECRAFT);
    await tudo();
    som.registrar({ situacao: 'falhou', motivo: 'o Windows recusou' });
    expect(som.snapshot().real).toMatchObject({ rotulo: 'SEM SOM · o Windows recusou', tom: 'alerta' });
    som.escolherSistema();
    expect(som.snapshot().resultado).toBeNull();
    expect(som.snapshot().real.rotulo).toContain('SISTEMA');
  });

  it('avisa os assinantes a cada mudança', async () => {
    const { som } = montar();
    const o = vi.fn();
    const sai = som.assinar(o);
    som.escolherNenhum();
    expect(o).toHaveBeenCalled();
    sai();
    o.mockClear();
    som.escolherSistema();
    expect(o).not.toHaveBeenCalled();
  });

  it('a falha de listar não esvazia a lista', async () => {
    const { som, listarApps, agendados } = montar();
    som.observar();
    som.escolherJogo();
    await tudo();
    listarApps.mockRejectedValueOnce(new Error('x'));
    agendados[0]!();
    await tudo();
    expect(som.snapshot().apps).toEqual([MINECRAFT, DISCORD]);
  });

  it('consultar o main falhar vira "indisponível" com motivo', async () => {
    const som = makeSomDesktop({
      plataforma: 'linux',
      capacidades: () => Promise.reject(new Error('sem ponte')),
      listarApps: () => Promise.resolve([]),
      agendar: () => () => undefined,
    });
    som.observar();
    await tudo();
    expect(som.snapshot().capacidades?.jogo.disponivel).toBe(false);
  });
});

describe('escolha guardada — o padrão seguro é SEM SOM', () => {
  it('sem nada guardado, sem som (sistema traria a call de volta para quem assiste)', () => {
    expect(escolhaGuardada(null)).toEqual({ tipo: 'nenhum' });
    expect(escolhaGuardada('qualquer-coisa')).toEqual({ tipo: 'nenhum' });
  });
  it('sistema e jogo voltam como foram escolhidos; do jogo, só o nome', () => {
    expect(escolhaGuardada(serializarEscolha({ tipo: 'sistema' }))).toEqual({ tipo: 'sistema' });
    expect(escolhaGuardada(serializarEscolha({ tipo: 'jogo', appId: '123', nome: 'Minecraft' }))).toEqual({
      tipo: 'jogo',
      appId: null,
      nome: 'Minecraft',
    });
    expect(escolhaGuardada(serializarEscolha({ tipo: 'nenhum' }))).toEqual({ tipo: 'nenhum' });
  });
});

import { describe, expect, it } from 'vitest';
import type { PedidoAoUtilitario } from './protocolo-utilitario.js';
import { type DepsDoSomWindows, PERIODO_DA_REAVALIACAO_MS, type ProcessoUtilitario, SomDoJogoWindows } from './som-jogo-windows.js';

type Porta = { nome: string; fechada: boolean };

/** Um utility de mentira: o teste decide o que ele responde e quando morre. */
function utilitarioFalso(responder: (p: PedidoAoUtilitario, ports: readonly unknown[]) => unknown[] | 'mudo') {
  const ouvintes: Array<(m: unknown) => void> = [];
  const saidas: Array<(c: number | null) => void> = [];
  const pedidos: PedidoAoUtilitario[] = [];
  let mortos = 0;
  const proc: ProcessoUtilitario & { enviar(m: unknown): void; morrer(): void; pedidos: PedidoAoUtilitario[]; mortos: () => number } = {
    pedidos,
    mortos: () => mortos,
    postMessage(m, transferir) {
      pedidos.push(m);
      const r = responder(m, transferir ?? []);
      if (r !== 'mudo') queueMicrotask(() => r.forEach((x) => ouvintes.forEach((o) => o(x))));
    },
    aoMensagem: (o) => ouvintes.push(o),
    aoSair: (o) => saidas.push(o),
    kill: () => {
      mortos++;
      queueMicrotask(() => saidas.forEach((o) => o(0)));
      return true;
    },
    enviar: (m) => ouvintes.forEach((o) => o(m)),
    morrer: () => saidas.forEach((o) => o(1)),
  };
  return proc;
}

const SESSOES = [
  { pid: 100, nome: 'Jogo', caminho: 'C:\\Jogos\\Jogo.exe', ativa: true },
  { pid: 200, nome: 'Discord', caminho: 'C:\\Discord.exe', ativa: true },
];

function montar(
  opcoes: {
    release?: string;
    addon?: boolean;
    utilitario?: (p: PedidoAoUtilitario, ports: readonly unknown[]) => unknown[] | 'mudo';
    prazo?: 'imediato' | 'nunca';
  } = {},
) {
  const sondaOk = { t: 'sonda', ok: true, versao: '1.0.0' };
  const padrao = (p: PedidoAoUtilitario): unknown[] | 'mudo' =>
    p.t === 'sondar' ? [sondaOk] : p.t === 'listar' ? [{ t: 'sessoes', sessoes: SESSOES }] : p.t === 'capturar' ? [{ t: 'capturando' }] : [];
  const processos: Array<ReturnType<typeof utilitarioFalso>> = [];
  const canais: Array<{ paraUtilitario: Porta; paraRenderer: Porta; fechar(): void }> = [];
  /** O que está agendado, por prazo: o teste dispara a reavaliação do modo sistema na mão. */
  const agendados: Array<{ fn: () => void; ms: number; cancelado: boolean }> = [];
  const deps: DepsDoSomWindows<Porta> = {
    forkUtilitario: () => {
      const p = utilitarioFalso(opcoes.utilitario ?? padrao);
      processos.push(p);
      return p;
    },
    criarCanal: () => {
      const c = { paraUtilitario: { nome: 'u', fechada: false }, paraRenderer: { nome: 'r', fechada: false }, fechar() { c.paraUtilitario.fechada = true; c.paraRenderer.fechada = true; } };
      canais.push(c);
      return c;
    },
    agendar: (fn, ms) => {
      if (opcoes.prazo === 'imediato') queueMicrotask(fn);
      const item = { fn, ms, cancelado: false };
      agendados.push(item);
      return () => {
        item.cancelado = true;
      };
    },
    pidsDoTela: () => new Set([999]),
    pidPrincipal: () => 999,
    release: () => opcoes.release ?? '10.0.22631',
    addonPresente: () => opcoes.addon ?? true,
  };
  /** Dispara a reavaliação pendente (a de 5 s) e espera o que ela pergunta ao utility. */
  const reavaliar = async (): Promise<void> => {
    const item = agendados.filter((a) => a.ms === PERIODO_DA_REAVALIACAO_MS && !a.cancelado).at(-1);
    if (item === undefined) throw new Error('nenhuma reavaliação agendada');
    item.cancelado = true;
    item.fn();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const reavaliacoesPendentes = () => agendados.filter((a) => a.ms === PERIODO_DA_REAVALIACAO_MS && !a.cancelado).length;
  return { som: new SomDoJogoWindows<Porta>(deps), processos, canais, reavaliar, reavaliacoesPendentes };
}

describe('disponibilidade', () => {
  it('disponível: Windows novo, addon presente, utility respondendo', async () => {
    const { som, processos } = montar();
    expect(await som.disponibilidade()).toEqual({ disponivel: true, motivo: null });
    // A resposta fica guardada: a sonda sobe um processo só.
    await som.disponibilidade();
    expect(processos).toHaveLength(1);
    expect(processos[0]!.mortos()).toBeGreaterThan(0);
  });

  it('Windows antigo: desabilitado com o motivo, sem subir processo', async () => {
    const { som, processos } = montar({ release: '10.0.18363' });
    const d = await som.disponibilidade();
    expect(d.disponivel).toBe(false);
    expect(d.motivo).toContain('2004');
    expect(processos).toHaveLength(0);
  });

  it('sem o .node no pacote: desabilitado com o motivo', async () => {
    const { som, processos } = montar({ addon: false });
    expect((await som.disponibilidade()).motivo).toContain('não carregou');
    expect(processos).toHaveLength(0);
  });

  it('addon que não carrega no utility: desabilitado', async () => {
    const { som } = montar({ utilitario: () => [{ t: 'sonda', ok: false, erro: 'ADDON_AUSENTE' }] });
    expect(await som.disponibilidade()).toMatchObject({ disponivel: false });
  });

  it('utility mudo: o prazo vence e vira indisponível', async () => {
    const { som } = montar({ utilitario: () => 'mudo', prazo: 'imediato' });
    expect((await som.disponibilidade()).disponivel).toBe(false);
  });

  it('utility que morre sem responder: indisponível', async () => {
    const { som, processos } = montar({ utilitario: () => 'mudo' });
    const p = som.disponibilidade();
    await Promise.resolve();
    processos[0]!.morrer();
    expect((await p).disponivel).toBe(false);
  });
});

describe('listar', () => {
  it('lista os apps com sessão, sem o próprio Tela', async () => {
    const { som } = montar();
    expect((await som.listar()).map((a) => a.id)).toEqual(['pid:200', 'pid:100']);
  });

  it('indisponível lista vazio', async () => {
    expect(await montar({ release: '6.1.7601' }).som.listar()).toEqual([]);
  });
});

describe('iniciar / parar', () => {
  it('só captura um pid que o seletor ofereceu', async () => {
    const { som } = montar();
    await som.listar();
    expect(await som.iniciar('pid:5555', { encerrou: () => undefined })).toEqual({ ok: false, error: 'APP_NAO_ENCONTRADO' });
    expect(await som.iniciar('lixo', { encerrou: () => undefined })).toEqual({ ok: false, error: 'APP_NAO_ENCONTRADO' });
  });

  it('manda o pid e a porta do PCM ao utility e devolve a outra ponta ao renderer', async () => {
    const { som, processos, canais } = montar();
    await som.listar();
    const r = await som.iniciar('pid:100', { encerrou: () => undefined });
    expect(r.ok && r.value.app).toBe('Jogo');
    expect(r.ok && r.value.porta).toBe(canais[0]!.paraRenderer);
    const captura = processos.at(-1)!;
    // "Só o jogo" INCLUI o jogo (e a árvore dele).
    expect(captura.pedidos).toContainEqual({ t: 'capturar', pid: 100, modo: 'incluir' });
    expect(som.idAtivo()).toBe(r.ok ? r.value.id : null);
  });

  it('S-08: o pid foi reciclado por outro executável entre a listagem e o iniciar: recusa e não sobe a captura', async () => {
    let listagens = 0;
    const { som, processos } = montar({
      utilitario: (p) => {
        if (p.t === 'sondar') return [{ t: 'sonda', ok: true, versao: '1' }];
        if (p.t === 'listar') {
          listagens += 1;
          // 1ª: o jogo no pid 100. 2ª: o pid 100 agora é o Discord.
          return [{ t: 'sessoes', sessoes: listagens === 1 ? SESSOES : [{ pid: 100, nome: 'Discord', caminho: 'C:\\Discord.exe', ativa: true }] }];
        }
        return [{ t: 'capturando' }];
      },
    });
    await som.listar();
    expect(await som.iniciar('pid:100', { encerrou: () => undefined })).toEqual({ ok: false, error: 'APP_NAO_ENCONTRADO' });
    expect(processos.some((x) => x.pedidos.some((q) => q.t === 'capturar'))).toBe(false);
    expect(som.idAtivo()).toBeNull();
    // E o pid sai da lista oferecida: nova tentativa sem listar de novo também recusa.
    expect(await som.iniciar('pid:100', { encerrou: () => undefined })).toEqual({ ok: false, error: 'APP_NAO_ENCONTRADO' });
  });

  it('S-08: o pid sumiu da segunda listagem: recusa; mesmo executável (caixa diferente) segue', async () => {
    let listagens = 0;
    const { som } = montar({
      utilitario: (p) => {
        if (p.t === 'sondar') return [{ t: 'sonda', ok: true, versao: '1' }];
        if (p.t === 'listar') {
          listagens += 1;
          return [{ t: 'sessoes', sessoes: listagens === 1 ? SESSOES : [] }];
        }
        return [{ t: 'capturando' }];
      },
    });
    await som.listar();
    expect(await som.iniciar('pid:100', { encerrou: () => undefined })).toEqual({ ok: false, error: 'APP_NAO_ENCONTRADO' });

    const igual = montar({
      utilitario: (p) =>
        p.t === 'sondar'
          ? [{ t: 'sonda', ok: true, versao: '1' }]
          : p.t === 'listar'
            ? [{ t: 'sessoes', sessoes: [{ pid: 100, nome: 'Jogo', caminho: 'c:\\jogos\\JOGO.EXE', ativa: true }] }]
            : [{ t: 'capturando' }],
    });
    await igual.som.listar();
    expect((await igual.som.iniciar('pid:100', { encerrou: () => undefined })).ok).toBe(true);
  });

  it('uma sessão por vez', async () => {
    const { som } = montar();
    await som.listar();
    await som.iniciar('pid:100', { encerrou: () => undefined });
    expect(await som.iniciar('pid:200', { encerrou: () => undefined })).toEqual({ ok: false, error: 'OCUPADO' });
  });

  it('ativação recusada pelo Windows vira FALHOU e fecha a porta', async () => {
    const { som, canais } = montar({
      utilitario: (p) => (p.t === 'sondar' ? [{ t: 'sonda', ok: true, versao: '1' }] : p.t === 'listar' ? [{ t: 'sessoes', sessoes: SESSOES }] : [{ t: 'erro', erro: 'ATIVACAO_RECUSADA' }]),
    });
    await som.listar();
    expect(await som.iniciar('pid:100', { encerrou: () => undefined })).toEqual({ ok: false, error: 'FALHOU' });
    expect(canais[0]!.paraRenderer.fechada).toBe(true);
    expect(som.idAtivo()).toBeNull();
  });

  it('processo que já fechou: APP_NAO_ENCONTRADO', async () => {
    const { som } = montar({
      utilitario: (p) => (p.t === 'sondar' ? [{ t: 'sonda', ok: true, versao: '1' }] : p.t === 'listar' ? [{ t: 'sessoes', sessoes: SESSOES }] : [{ t: 'erro', erro: 'PROCESSO_INVALIDO' }]),
    });
    await som.listar();
    expect(await som.iniciar('pid:100', { encerrou: () => undefined })).toEqual({ ok: false, error: 'APP_NAO_ENCONTRADO' });
  });

  it('o jogo fecha: avisa uma vez e libera a sessão', async () => {
    const { som, processos } = montar();
    await som.listar();
    const fins: string[] = [];
    await som.iniciar('pid:100', { encerrou: (f) => fins.push(f.motivo) });
    processos.at(-1)!.enviar({ t: 'fim', motivo: 'PROCESSO_ENCERROU' });
    processos.at(-1)!.morrer();
    expect(fins).toEqual(['PROCESSO_ENCERROU']);
    expect(som.idAtivo()).toBeNull();
  });

  it('o utility cai com o jogo no ar: COMPONENTE_CAIU', async () => {
    const { som, processos } = montar();
    await som.listar();
    const fins: string[] = [];
    await som.iniciar('pid:100', { encerrou: (f) => fins.push(f.motivo) });
    processos.at(-1)!.morrer();
    expect(fins).toEqual(['COMPONENTE_CAIU']);
  });

  it('parar pede ao utility, fecha a porta e não avisa quem pediu', async () => {
    const { som, processos, canais } = montar({ prazo: 'nunca' });
    await som.listar();
    const fins: string[] = [];
    await som.iniciar('pid:100', { encerrou: (f) => fins.push(f.motivo) });
    const captura = processos.at(-1)!;
    const parada = som.parar();
    captura.morrer();
    await parada;
    expect(captura.pedidos).toContainEqual({ t: 'parar' });
    expect(canais[0]!.paraRenderer.fechada).toBe(true);
    expect(fins).toEqual([]);
    expect(som.idAtivo()).toBeNull();
    await som.parar(); // idempotente
  });
});

describe('iniciarSistema: tudo que toca, menos a call', () => {
  /** Um utility cujas sessões o teste troca no meio (o Discord abre depois). */
  function comSessoes(inicial: ReadonlyArray<{ pid: number; nome: string; caminho: string; ativa: boolean }>, troca: 'ok' | 'erro' = 'ok') {
    let sessoes = inicial;
    const m = montar({
      utilitario: (p) =>
        p.t === 'sondar'
          ? [{ t: 'sonda', ok: true, versao: '1.1.0' }]
          : p.t === 'listar'
            ? [{ t: 'sessoes', sessoes }]
            : p.t === 'capturar'
              ? [{ t: 'capturando' }]
              : p.t === 'trocar'
                ? [troca === 'ok' ? { t: 'capturando' } : { t: 'erro', erro: 'ATIVACAO_RECUSADA' }]
                : [],
    });
    return { ...m, mudarSessoes: (novas: typeof inicial) => (sessoes = novas) };
  }

  it('exclui o Discord: pede ao utility a captura em modo "excluir" com o pid dele e entrega a porta', async () => {
    const { som, processos, canais } = comSessoes(SESSOES);
    const r = await som.iniciarSistema({ encerrou: () => undefined });
    expect(r.ok && r.value.porta).toBe(canais[0]!.paraRenderer);
    const captura = processos.at(-1)!;
    // Lista no MESMO utility que captura: um processo a menos.
    expect(captura.pedidos.map((p) => p.t)).toEqual(['listar', 'capturar']);
    expect(captura.pedidos).toContainEqual({ t: 'capturar', pid: 200, modo: 'excluir' });
    expect(som.idAtivo()).toBe(r.ok ? r.value.id : null);
  });

  it('não precisa do seletor: não depende de listar() antes', async () => {
    const { som } = comSessoes(SESSOES);
    expect((await som.iniciarSistema({ encerrou: () => undefined })).ok).toBe(true);
  });

  it('sem app de voz aberto, exclui o próprio Tela', async () => {
    const { som, processos } = comSessoes([{ pid: 100, nome: 'Jogo', caminho: 'C:\\Jogo.exe', ativa: true }]);
    await som.iniciarSistema({ encerrou: () => undefined });
    expect(processos.at(-1)!.pedidos).toContainEqual({ t: 'capturar', pid: 999, modo: 'excluir' });
  });

  it('o Discord abre depois: a reavaliação troca o alvo na mesma captura (mesmo utility, mesma porta)', async () => {
    const { som, processos, canais, mudarSessoes, reavaliar } = comSessoes([{ pid: 100, nome: 'Jogo', caminho: 'C:\\Jogo.exe', ativa: true }]);
    await som.iniciarSistema({ encerrou: () => undefined });
    const captura = processos.at(-1)!;
    const antes = processos.length;

    await reavaliar();
    // Nada mudou: não troca.
    expect(captura.pedidos.filter((p) => p.t === 'trocar')).toEqual([]);

    mudarSessoes(SESSOES);
    await reavaliar();
    expect(captura.pedidos.filter((p) => p.t === 'trocar')).toEqual([{ t: 'trocar', pid: 200, modo: 'excluir' }]);
    expect(processos.length).toBe(antes);
    expect(canais).toHaveLength(1);
    expect(canais[0]!.paraRenderer.fechada).toBe(false);

    // E não troca de novo enquanto o alvo for o mesmo.
    await reavaliar();
    expect(captura.pedidos.filter((p) => p.t === 'trocar')).toHaveLength(1);
  });

  it('o Discord fecha: volta a excluir só o Tela', async () => {
    const { som, processos, mudarSessoes, reavaliar } = comSessoes(SESSOES);
    await som.iniciarSistema({ encerrou: () => undefined });
    mudarSessoes([SESSOES[0]!]);
    await reavaliar();
    expect(processos.at(-1)!.pedidos.at(-1)).toEqual({ t: 'trocar', pid: 999, modo: 'excluir' });
  });

  it('uma troca que o Windows recusa encerra: a página mostra o motivo', async () => {
    const { som, mudarSessoes, reavaliar, canais } = comSessoes([], 'erro');
    const fins: string[] = [];
    await som.iniciarSistema({ encerrou: (f) => fins.push(f.motivo) });
    mudarSessoes(SESSOES);
    await reavaliar();
    expect(fins).toEqual(['COMPONENTE_CAIU']);
    expect(som.idAtivo()).toBeNull();
    expect(canais[0]!.paraRenderer.fechada).toBe(true);
  });

  it('o utility caindo encerra a captura e a reavaliação', async () => {
    const { som, processos, reavaliacoesPendentes } = comSessoes(SESSOES);
    const fins: string[] = [];
    await som.iniciarSistema({ encerrou: (f) => fins.push(f.motivo) });
    expect(reavaliacoesPendentes()).toBe(1);
    processos.at(-1)!.morrer();
    expect(fins).toEqual(['COMPONENTE_CAIU']);
    // E a reavaliação para junto.
    expect(reavaliacoesPendentes()).toBe(0);
  });

  it('parar cancela a reavaliação e não avisa quem pediu', async () => {
    const { som, processos, reavaliacoesPendentes } = comSessoes(SESSOES);
    const fins: string[] = [];
    await som.iniciarSistema({ encerrou: (f) => fins.push(f.motivo) });
    const parada = som.parar();
    processos.at(-1)!.morrer();
    await parada;
    expect(processos.at(-1)!.pedidos.at(-1)).toEqual({ t: 'parar' });
    expect(reavaliacoesPendentes()).toBe(0);
    expect(fins).toEqual([]);
    expect(som.idAtivo()).toBeNull();
  });

  it('uma sessão por vez, com o "só o jogo" também', async () => {
    const { som } = comSessoes(SESSOES);
    await som.listar();
    await som.iniciarSistema({ encerrou: () => undefined });
    expect(await som.iniciarSistema({ encerrou: () => undefined })).toEqual({ ok: false, error: 'OCUPADO' });
    expect(await som.iniciar('pid:100', { encerrou: () => undefined })).toEqual({ ok: false, error: 'OCUPADO' });
  });

  it('indisponível (Windows antigo): não sobe a captura nem cai para o loopback do sistema', async () => {
    const { som, processos } = montar({ release: '10.0.18363' });
    expect(await som.iniciarSistema({ encerrou: () => undefined })).toEqual({ ok: false, error: 'INDISPONIVEL' });
    expect(processos).toHaveLength(0);
  });

  it('ativação recusada: FALHOU e fecha a porta; addon velho: INDISPONIVEL', async () => {
    const recusa = montar({
      utilitario: (p) => (p.t === 'sondar' ? [{ t: 'sonda', ok: true, versao: '1.1.0' }] : p.t === 'listar' ? [{ t: 'sessoes', sessoes: SESSOES }] : [{ t: 'erro', erro: 'ATIVACAO_RECUSADA' }]),
    });
    expect(await recusa.som.iniciarSistema({ encerrou: () => undefined })).toEqual({ ok: false, error: 'FALHOU' });
    expect(recusa.canais[0]!.paraRenderer.fechada).toBe(true);

    const velho = montar({
      utilitario: (p) => (p.t === 'sondar' ? [{ t: 'sonda', ok: true, versao: '1.0.0' }] : p.t === 'listar' ? [{ t: 'sessoes', sessoes: SESSOES }] : [{ t: 'erro', erro: 'ADDON_AUSENTE' }]),
    });
    expect(await velho.som.iniciarSistema({ encerrou: () => undefined })).toEqual({ ok: false, error: 'INDISPONIVEL' });
  });

  it('o app de voz fechou entre a listagem e a ativação: FALHOU, não "programa não encontrado"', async () => {
    const { som } = montar({
      utilitario: (p) => (p.t === 'sondar' ? [{ t: 'sonda', ok: true, versao: '1.1.0' }] : p.t === 'listar' ? [{ t: 'sessoes', sessoes: SESSOES }] : [{ t: 'erro', erro: 'PROCESSO_INVALIDO' }]),
    });
    expect(await som.iniciarSistema({ encerrou: () => undefined })).toEqual({ ok: false, error: 'FALHOU' });
  });
});

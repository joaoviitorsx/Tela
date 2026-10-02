import { describe, expect, it } from 'vitest';
import type { PedidoAoUtilitario } from './protocolo-utilitario.js';
import { type DepsDoSomWindows, type ProcessoUtilitario, SomDoJogoWindows } from './som-jogo-windows.js';

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

function montar(opcoes: { release?: string; addon?: boolean; utilitario?: (p: PedidoAoUtilitario, ports: readonly unknown[]) => unknown[] | 'mudo'; prazo?: 'imediato' | 'nunca' } = {}) {
  const sondaOk = { t: 'sonda', ok: true, versao: '1.0.0' };
  const padrao = (p: PedidoAoUtilitario): unknown[] | 'mudo' =>
    p.t === 'sondar' ? [sondaOk] : p.t === 'listar' ? [{ t: 'sessoes', sessoes: SESSOES }] : p.t === 'capturar' ? [{ t: 'capturando' }] : [];
  const processos: Array<ReturnType<typeof utilitarioFalso>> = [];
  const canais: Array<{ paraUtilitario: Porta; paraRenderer: Porta; fechar(): void }> = [];
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
    agendar: (fn) => {
      if (opcoes.prazo === 'imediato') queueMicrotask(fn);
      return () => undefined;
    },
    pidsDoTela: () => new Set([999]),
    release: () => opcoes.release ?? '10.0.22631',
    addonPresente: () => opcoes.addon ?? true,
  };
  return { som: new SomDoJogoWindows<Porta>(deps), processos, canais };
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
    expect(captura.pedidos).toContainEqual({ t: 'capturar', pid: 100 });
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

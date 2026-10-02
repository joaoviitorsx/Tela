import { describe, expect, it, vi } from 'vitest';
import {
  argumentosDoHelper,
  bitrateInicial,
  CapturaNativa,
  type FimDaCapturaNativa,
  lerTokenDoPortal,
  ordemValida,
  pedidoDeCapturaValido,
  type ProcessoFilho,
  type SaidasDaSessao,
  serializarTokenDoPortal,
  sondarNvenc,
} from './captura-nativa.js';

/** Uma mensagem do protocolo, como o `tela-captura` escreve. */
function mensagem(tipo: number, corpo: Buffer): Buffer {
  const h = Buffer.alloc(5);
  h.writeUInt32LE(1 + corpo.length, 0);
  h[4] = tipo;
  return Buffer.concat([h, corpo]);
}
const evento = (e: Record<string, unknown>) => mensagem(2, Buffer.from(JSON.stringify(e)));
const quadro = (seq: number) => {
  const cab = Buffer.alloc(9);
  cab[0] = 1;
  cab.writeUInt16LE(1920, 1);
  cab.writeUInt16LE(1080, 3);
  cab.writeUInt32LE(seq, 5);
  return mensagem(1, Buffer.concat([cab, Buffer.from([0, 0, 0, 1, 0x65])]));
};
const captura = () => mensagem(3, Buffer.alloc(0));

/** Processo de mentira: o teste escreve no stdout dele e decide quando sai. */
function processoFalso(args: readonly string[]) {
  const ouvintes = { data: [] as Array<(b: Buffer) => void>, exit: [] as Array<(c: number | null) => void>, error: [] as Array<(e: Error) => void> };
  const stdin: string[] = [];
  const mortes: string[] = [];
  let fechado = false;
  const processo: ProcessoFilho & {
    args: readonly string[];
    stdinLinhas: string[];
    mortes: string[];
    fechado: () => boolean;
    emitir: (b: Buffer) => void;
    sair: (c: number | null) => void;
    falhar: () => void;
  } = {
    args,
    stdinLinhas: stdin,
    mortes,
    fechado: () => fechado,
    stdout: { on: (_e, cb) => ouvintes.data.push(cb) },
    stdin: {
      write: (s: string) => stdin.push(s),
      end: () => {
        fechado = true;
      },
    },
    on: (e, cb) => {
      if (e === 'exit') ouvintes.exit.push(cb as (c: number | null) => void);
      else ouvintes.error.push(cb as (e: Error) => void);
    },
    kill: (sinal = 'SIGTERM') => {
      mortes.push(sinal);
      return true;
    },
    emitir: (b) => ouvintes.data.forEach((cb) => cb(b)),
    sair: (c) => ouvintes.exit.forEach((cb) => cb(c)),
    falhar: () => ouvintes.error.forEach((cb) => cb(new Error('ENOENT'))),
  };
  return processo;
}

function relogioFalso() {
  const pendentes: Array<{ fn: () => void; em: number; cancelado: boolean }> = [];
  let agora = 0;
  return {
    agendar: (fn: () => void, ms: number) => {
      const t = { fn, em: agora + ms, cancelado: false };
      pendentes.push(t);
      return () => {
        t.cancelado = true;
      };
    },
    avancar: (ms: number) => {
      agora += ms;
      for (const t of [...pendentes]) {
        if (!t.cancelado && t.em <= agora) {
          t.cancelado = true;
          t.fn();
        }
      }
    },
  };
}

function montar() {
  const processos: ReturnType<typeof processoFalso>[] = [];
  const relogio = relogioFalso();
  let semBinario = false;
  const captura = new CapturaNativa({
    spawn: (args) => {
      if (semBinario) throw new Error('ENOENT');
      const p = processoFalso(args);
      processos.push(p);
      return p;
    },
    agendar: relogio.agendar,
  });
  const fins: FimDaCapturaNativa[] = [];
  const eventos: Array<Record<string, unknown>> = [];
  const quadros: number[] = [];
  const capturas = vi.fn();
  const saidas: SaidasDaSessao = {
    quadro: (q) => quadros.push(q.seq),
    captura: capturas,
    evento: (e) => eventos.push(e),
    encerrou: (f) => fins.push(f),
  };
  const PEDIDO = { width: 1920, height: 1080, fps: 60 };
  return {
    captura,
    processos,
    relogio,
    fins,
    eventos,
    quadros,
    capturas,
    saidas,
    PEDIDO,
    semBinario: () => {
      semBinario = true;
    },
  };
}

const PRONTO = { evento: 'pronto', fonte: { width: 2560, height: 1600 }, memoria: 'dmabuf', restaurar: 'tok-1' };

describe('validação do IPC', () => {
  it('pedidoDeCapturaValido aceita inteiros razoáveis e arredonda para par', () => {
    expect(pedidoDeCapturaValido({ width: 1919, height: 1080, fps: 60 })).toEqual({ width: 1918, height: 1080, fps: 60 });
    expect(pedidoDeCapturaValido({ width: 1920, height: 1080, fps: 60, extra: 1 })).toEqual({ width: 1920, height: 1080, fps: 60 });
  });
  it('pedidoDeCapturaValido recusa o resto', () => {
    for (const p of [
      null,
      undefined,
      'x',
      {},
      { width: 1920, height: 1080 },
      { width: 1920.5, height: 1080, fps: 60 },
      { width: 0, height: 1080, fps: 60 },
      { width: 1920, height: 1080, fps: 0 },
      { width: 1920, height: 1080, fps: 1000 },
      { width: 100000, height: 1080, fps: 60 },
      { width: '1920', height: 1080, fps: 60 },
    ]) {
      expect(pedidoDeCapturaValido(p), JSON.stringify(p)).toBeNull();
    }
  });
  it('ordemValida só deixa passar o protocolo de ordens', () => {
    expect(ordemValida('alvo 1920 1080 60 12000000')).toBe('alvo 1920 1080 60 12000000');
    expect(ordemValida('chave')).toBe('chave');
    expect(ordemValida('atraso 3')).toBe('atraso 3');
    expect(ordemValida('parar')).toBe('parar');
    expect(ordemValida('teto 5')).toBe('teto 5');
    expect(ordemValida('teto 0')).toBe('teto 0');
    expect(ordemValida('teto 240')).toBe('teto 240');
    for (const l of ['', 'alvo', 'alvo 1 2 3', 'chave\nparar', 'rm -rf /', 'atraso -1', 'teto', 'teto -1', 'teto 241', 'teto 999', 'teto 1000', 'teto 5 5', 'teto 5.5', 'alvo 1920 1080 60 12000000 x', 7, null]) {
      expect(ordemValida(l), String(l)).toBeNull();
    }
  });
  it('ordemValida aplica ao `alvo` os mesmos tetos do `iniciar` (S-15)', () => {
    expect(ordemValida('alvo 7680 4320 240 200000000')).toBe('alvo 7680 4320 240 200000000');
    for (const l of [
      'alvo 99999 99999 999 999999999',
      'alvo 7682 1080 60 1000000',
      'alvo 1920 7682 60 1000000',
      'alvo 1920 1080 241 1000000',
      'alvo 1920 1080 0 1000000',
      'alvo 1920 1080 60 200000001',
      'alvo 0 0 60 1000000',
      'alvo 1 1080 60 1000000',
    ]) {
      expect(ordemValida(l), l).toBeNull();
    }
  });
  it('argumentos do helper: portal, alvo com 0,1 bpp e o token quando há', () => {
    const p = { width: 1920, height: 1080, fps: 60 };
    expect(bitrateInicial(p)).toBe(12_441_600);
    expect(argumentosDoHelper(p, null)).toEqual(['--fonte=portal', '--alvo=1920,1080,60,12441600']);
    expect(argumentosDoHelper(p, 'abc')).toEqual(['--fonte=portal', '--alvo=1920,1080,60,12441600', '--restaurar=abc']);
    expect(argumentosDoHelper(p, '')).toHaveLength(2);
    expect(bitrateInicial({ width: 320, height: 180, fps: 30 })).toBe(1_000_000);
    expect(bitrateInicial({ width: 7680, height: 4320, fps: 240 })).toBe(25_000_000);
  });
  it('token do portal: vai e volta, e lixo vira null', () => {
    expect(lerTokenDoPortal(serializarTokenDoPortal('tok'))).toBe('tok');
    expect(lerTokenDoPortal(null)).toBeNull();
    expect(lerTokenDoPortal('{')).toBeNull();
    expect(lerTokenDoPortal('[]')).toBeNull();
    expect(lerTokenDoPortal('{"restaurar":""}')).toBeNull();
    expect(lerTokenDoPortal(`{"restaurar":"${'a'.repeat(600)}"}`)).toBeNull();
  });
});

describe('CapturaNativa', () => {
  it('sobe o processo com o token, resolve no `pronto` e repassa quadros, capturas e eventos', async () => {
    const m = montar();
    const promessa = m.captura.iniciar(m.PEDIDO, 'tok-0', m.saidas);
    expect(m.processos[0]?.args).toEqual(['--fonte=portal', '--alvo=1920,1080,60,12441600', '--restaurar=tok-0']);
    expect(m.captura.idAtual).toBeNull();

    // Antes do pronto nada de quadro chega ao renderer: não há sender para recebê-lo.
    m.processos[0]!.emitir(quadro(0));
    m.processos[0]!.emitir(evento({ evento: 'stats', msPorQuadro: 2.5 }));
    m.processos[0]!.emitir(evento(PRONTO));
    const r = await promessa;
    expect(r).toEqual({ ok: true, value: { id: 1, fonte: { width: 2560, height: 1600 }, memoria: 'dmabuf', restaurar: 'tok-1' } });
    expect(m.captura.idAtual).toBe(1);
    expect(m.eventos.map((e) => e['evento'])).toEqual(['stats', 'pronto']);

    m.processos[0]!.emitir(Buffer.concat([quadro(1), captura(), quadro(2)]));
    expect(m.quadros).toEqual([1, 2]);
    expect(m.capturas).toHaveBeenCalledTimes(1);
  });

  it('ordens validadas vão ao stdin; `parar` encerra e escala para sinais', async () => {
    const m = montar();
    const promessa = m.captura.iniciar(m.PEDIDO, null, m.saidas);
    m.processos[0]!.emitir(evento(PRONTO));
    await promessa;

    m.captura.ordem(1, 'alvo 1280 720 60 5000000');
    m.captura.ordem(1, 'chave');
    m.captura.ordem(99, 'chave'); // sessão que não existe: ignorada
    expect(m.processos[0]!.stdinLinhas).toEqual(['alvo 1280 720 60 5000000\n', 'chave\n']);

    m.captura.ordem(1, 'parar');
    expect(m.processos[0]!.stdinLinhas.at(-1)).toBe('parar\n');
    expect(m.processos[0]!.fechado()).toBe(true);
    expect(m.captura.idAtual).toBeNull();
    m.relogio.avancar(1500);
    expect(m.processos[0]!.mortes).toEqual(['SIGTERM']);
    m.relogio.avancar(1500);
    expect(m.processos[0]!.mortes).toEqual(['SIGTERM', 'SIGKILL']);

    // Saiu: quem pediu para parar não recebe `encerrou`.
    m.processos[0]!.sair(0);
    expect(m.fins).toEqual([]);
    // Ordem depois de encerrado não vai a lugar nenhum.
    m.captura.ordem(1, 'chave');
    expect(m.processos[0]!.stdinLinhas.at(-1)).toBe('parar\n');
  });

  it('o processo sair sozinho cancela os sinais pendentes', async () => {
    const m = montar();
    const promessa = m.captura.iniciar(m.PEDIDO, null, m.saidas);
    m.processos[0]!.emitir(evento(PRONTO));
    await promessa;
    m.captura.parar(1);
    m.processos[0]!.sair(0);
    m.relogio.avancar(5000);
    expect(m.processos[0]!.mortes).toEqual([]);
  });

  it('a fonte fechar no sistema vira `encerrou` com o motivo do processo', async () => {
    const m = montar();
    const promessa = m.captura.iniciar(m.PEDIDO, null, m.saidas);
    m.processos[0]!.emitir(evento(PRONTO));
    await promessa;
    m.processos[0]!.emitir(evento({ evento: 'erro', codigo: 'FONTE_ENCERRADA', detalhe: '' }));
    m.processos[0]!.sair(4);
    expect(m.fins).toEqual([{ id: 1, motivo: 'FONTE_ENCERRADA', codigo: 4 }]);
    expect(m.captura.idAtual).toBeNull();
  });

  it('morrer sem explicação é MORREU; falha do pipeline é PIPELINE', async () => {
    const m = montar();
    const p1 = m.captura.iniciar(m.PEDIDO, null, m.saidas);
    m.processos[0]!.emitir(evento(PRONTO));
    await p1;
    m.processos[0]!.sair(null);
    expect(m.fins.at(-1)).toEqual({ id: 1, motivo: 'MORREU', codigo: null });

    const p2 = m.captura.iniciar(m.PEDIDO, null, m.saidas);
    m.processos[1]!.emitir(evento(PRONTO));
    await p2;
    m.processos[1]!.emitir(evento({ evento: 'erro', codigo: 'PIPELINE', detalhe: 'GL' }));
    m.processos[1]!.sair(2);
    expect(m.fins.at(-1)).toEqual({ id: 2, motivo: 'PIPELINE', codigo: 2 });
  });

  it('falhar antes do pronto resolve com o código do processo', async () => {
    const m = montar();
    const casos: Array<[string, number]> = [
      ['CANCELADO', 5],
      ['SEM_NVENC', 3],
      ['SEM_COMPONENTE', 3],
      ['PORTAL', 2],
      ['PIPELINE', 2],
    ];
    for (const [codigo, saida] of casos) {
      const promessa = m.captura.iniciar(m.PEDIDO, null, m.saidas);
      const p = m.processos.at(-1)!;
      p.emitir(evento({ evento: 'erro', codigo, detalhe: '' }));
      p.sair(saida);
      expect(await promessa, codigo).toEqual({ ok: false, error: codigo });
    }
    const semNada = m.captura.iniciar(m.PEDIDO, null, m.saidas);
    m.processos.at(-1)!.sair(1);
    expect(await semNada).toEqual({ ok: false, error: 'MORREU' });
    expect(m.fins).toEqual([]);
  });

  it('binário ausente: INDISPONIVEL, pelo spawn que lança ou pelo evento error', async () => {
    const m = montar();
    const p1 = m.captura.iniciar(m.PEDIDO, null, m.saidas);
    m.processos[0]!.falhar();
    expect(await p1).toEqual({ ok: false, error: 'INDISPONIVEL' });

    m.semBinario();
    expect(await m.captura.iniciar(m.PEDIDO, null, m.saidas)).toEqual({ ok: false, error: 'INDISPONIVEL' });
  });

  it('dois `iniciar` ao mesmo tempo: o segundo é OCUPADO', async () => {
    const m = montar();
    const p1 = m.captura.iniciar(m.PEDIDO, null, m.saidas);
    expect(await m.captura.iniciar(m.PEDIDO, null, m.saidas)).toEqual({ ok: false, error: 'OCUPADO' });
    m.processos[0]!.emitir(evento(PRONTO));
    expect((await p1).ok).toBe(true);
  });

  it('parar enquanto espera o portal cancela o pedido', async () => {
    const m = montar();
    const p1 = m.captura.iniciar(m.PEDIDO, null, m.saidas);
    m.captura.parar(1);
    expect(await p1).toEqual({ ok: false, error: 'CANCELADO' });
    m.processos[0]!.sair(0);
    expect(m.fins).toEqual([]);
  });

  it('trocar de fonte: a nova sobe antes, a antiga é parada em silêncio no pronto', async () => {
    const m = montar();
    const p1 = m.captura.iniciar(m.PEDIDO, null, m.saidas);
    m.processos[0]!.emitir(evento(PRONTO));
    await p1;

    const p2 = m.captura.iniciar(m.PEDIDO, 'tok-1', m.saidas);
    expect(m.captura.idAtual).toBe(1);
    expect(m.processos[1]!.args).toContain('--restaurar=tok-1');
    // Enquanto a nova espera o portal, a antiga continua entregando.
    m.processos[0]!.emitir(quadro(5));
    expect(m.quadros).toEqual([5]);

    m.processos[1]!.emitir(evento(PRONTO));
    const r = await p2;
    expect(r.ok && r.value.id).toBe(2);
    expect(m.captura.idAtual).toBe(2);
    expect(m.processos[0]!.stdinLinhas.at(-1)).toBe('parar\n');
    // Quadro atrasado da antiga não chega mais; o fim dela não é avisado.
    m.processos[0]!.emitir(quadro(6));
    m.processos[0]!.sair(0);
    expect(m.quadros).toEqual([5]);
    expect(m.fins).toEqual([]);
  });

  it('trocar de fonte e cancelar o portal: a antiga segue no ar', async () => {
    const m = montar();
    const p1 = m.captura.iniciar(m.PEDIDO, null, m.saidas);
    m.processos[0]!.emitir(evento(PRONTO));
    await p1;
    const p2 = m.captura.iniciar(m.PEDIDO, null, m.saidas);
    m.processos[1]!.emitir(evento({ evento: 'erro', codigo: 'CANCELADO' }));
    m.processos[1]!.sair(5);
    expect(await p2).toEqual({ ok: false, error: 'CANCELADO' });
    expect(m.captura.idAtual).toBe(1);
    expect(m.processos[0]!.stdinLinhas).toEqual([]);
  });

  it('pararTudo encerra o que estiver subindo e o que estiver capturando', async () => {
    const m = montar();
    const p1 = m.captura.iniciar(m.PEDIDO, null, m.saidas);
    m.processos[0]!.emitir(evento(PRONTO));
    await p1;
    const p2 = m.captura.iniciar(m.PEDIDO, null, m.saidas);
    m.captura.pararTudo();
    expect(await p2).toEqual({ ok: false, error: 'CANCELADO' });
    expect(m.processos[0]!.fechado()).toBe(true);
    expect(m.processos[1]!.fechado()).toBe(true);
    expect(m.captura.idAtual).toBeNull();
  });
});

describe('sondarNvenc', () => {
  function sonda(prazo?: number) {
    const processos: ReturnType<typeof processoFalso>[] = [];
    const relogio = relogioFalso();
    const promessa = sondarNvenc(
      {
        spawn: (args) => {
          const p = processoFalso(args);
          processos.push(p);
          return p;
        },
        agendar: relogio.agendar,
      },
      prazo,
    );
    return { promessa, processo: processos[0]!, relogio };
  }

  it('evento sonda + saída 0: NVENC usável, com a versão do GStreamer', async () => {
    const s = sonda();
    expect(s.processo.args).toEqual(['--sondar']);
    s.processo.emitir(evento({ evento: 'sonda', nvenc: true, gstreamer: 'GStreamer 1.28.7' }));
    s.processo.sair(0);
    expect(await s.promessa).toEqual({ nvenc: true, detalhe: 'GStreamer 1.28.7' });
  });

  it('erro + saída 3: não, com o código', async () => {
    const s = sonda();
    s.processo.emitir(evento({ evento: 'erro', codigo: 'SEM_NVENC', detalhe: 'nvh264enc' }));
    s.processo.sair(3);
    expect(await s.promessa).toEqual({ nvenc: false, detalhe: 'SEM_NVENC' });
  });

  it('saída 0 sem o evento não vale: binário antigo, sem --sondar', async () => {
    const s = sonda();
    s.processo.sair(0);
    expect(await s.promessa).toEqual({ nvenc: false, detalhe: 'MORREU' });
  });

  it('prazo estourado: mata e responde não', async () => {
    const s = sonda(1000);
    s.relogio.avancar(1000);
    expect(await s.promessa).toEqual({ nvenc: false, detalhe: 'PRAZO' });
    expect(s.processo.mortes).toEqual(['SIGKILL']);
    s.processo.sair(null); // a saída tardia não muda nada
  });

  it('sem binário: INDISPONIVEL', async () => {
    const r = await sondarNvenc({
      spawn: () => {
        throw new Error('ENOENT');
      },
      agendar: () => () => undefined,
    });
    expect(r).toEqual({ nvenc: false, detalhe: 'INDISPONIVEL' });
  });
});

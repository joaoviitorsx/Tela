import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { EfeitosLinux } from './som-jogo-linux.js';
import { SomDoJogoLinux } from './som-jogo-linux.js';

type No = { id: number; type: string; info: { state?: string; props: Record<string, unknown> } };
type Meta = { subject: number; key: string; type: string | null; value: unknown };

/**
 * Um PipeWire de mentira com o MESMO formato do `pw-dump`: parte do fixture
 * real, e reproduz o que importa — mover por `target.object`, apagar a chave
 * devolve ao padrão, o `pw-loopback` cria sink e retorno, e o sink some
 * quando o processo sai.
 */
function pwFalso(opcoes: { retornoNuncaLiga?: boolean; entradaNuncaLiga?: boolean; semDump?: boolean; ignoraSigterm?: boolean } = {}) {
  const base = JSON.parse(readFileSync(new URL('./fixtures/pw-dump-antes.json', import.meta.url), 'utf8')) as Array<
    No & { metadata?: Meta[]; props?: Record<string, unknown> }
  >;
  const saidaReal = base.find((o) => o.type.endsWith(':Node') && o.info.props['media.class'] === 'Audio/Sink')!.id;
  const nos = base.filter((o) => o.type.endsWith(':Node') || o.type.endsWith(':Client'));
  let links: Array<{ id: number; saida: number; entrada: number }> = [];
  const meta: Meta[] = (base.find((o) => o.type.endsWith(':Metadata'))?.metadata ?? []).filter((m) => m.key !== 'target.object');
  let proximoId = 500;
  const registro: string[] = [];
  const kills: string[] = [];
  const mortes: Array<() => void> = [];
  let pwLoopbackPid = 9000;

  const ligar = (stream: number): void => {
    links = links.filter((l) => l.saida !== stream);
    const alvo = meta.find((m) => m.subject === stream && m.key === 'target.object');
    const sink = alvo === undefined ? saidaReal : (nos.find((n) => n.info.props['node.name'] === alvo.value)?.id ?? saidaReal);
    links.push({ id: proximoId++, saida: stream, entrada: sink });
  };
  for (const n of nos) if (n.info.props['media.class'] === 'Stream/Output/Audio') ligar(n.id);

  const dumpAtual = (): string => {
    const objs: unknown[] = [
      ...nos,
      ...links.map((l) => ({ id: l.id, type: 'PipeWire:Interface:Link', info: { props: { 'link.output.node': l.saida, 'link.input.node': l.entrada } } })),
      { id: 40, type: 'PipeWire:Interface:Metadata', props: { 'metadata.name': 'default' }, metadata: meta },
    ];
    return JSON.stringify(objs);
  };

  const efeitos: EfeitosLinux = {
    executar: (c) => {
      registro.push(`${c.cmd} ${c.args.join(' ')}`);
      if (c.args[0] === '--version') return Promise.resolve({ codigo: 0, saida: '' });
      if (c.cmd === 'pw-dump') return Promise.resolve(opcoes.semDump ? { codigo: 1, saida: '' } : { codigo: 0, saida: dumpAtual() });
      if (c.cmd === 'pw-metadata') {
        const apagar = c.args.includes('-d');
        const resto = c.args.filter((a) => a !== '-n' && a !== 'default' && a !== '-d');
        const stream = Number(resto[0]);
        for (let i = meta.length - 1; i >= 0; i--) if (meta[i]!.subject === stream && meta[i]!.key === 'target.object') meta.splice(i, 1);
        if (!apagar) meta.push({ subject: stream, key: 'target.object', type: resto[3] ?? null, value: resto[2] });
        ligar(stream);
      }
      return Promise.resolve({ codigo: 0, saida: '' });
    },
    iniciarSink: (c) => {
      registro.push(`spawn ${c.cmd} ${c.args[1] ?? ''}`);
      pwLoopbackPid += 1;
      const cliente = { id: proximoId++, type: 'PipeWire:Interface:Client', info: { props: { 'application.process.binary': 'pw-loopback', 'application.process.id': pwLoopbackPid } } };
      const no = (nome: string, classe: string): No => ({ id: proximoId++, type: 'PipeWire:Interface:Node', info: { state: 'running', props: { 'node.name': nome, 'media.class': classe, 'client.id': cliente.id } } });
      const criados: No[] = [cliente as unknown as No];
      const argumentos = c.args.join(' ');
      if (argumentos.includes('media.class=Audio/Sink')) {
        const sink = no('tela_jogo', 'Audio/Sink');
        sink.info.props['node.description'] = 'Tela-Jogo';
        const retorno = no('tela_jogo_retorno', 'Stream/Output/Audio');
        criados.push(sink, retorno);
        if (!opcoes.retornoNuncaLiga) links.push({ id: proximoId++, saida: retorno.id, entrada: saidaReal });
      } else if (argumentos.includes('tela_jogo_mic')) {
        const fonte = no('tela_jogo_mic', 'Audio/Source');
        const cap = no('tela_jogo_mic_cap', 'Stream/Input/Audio');
        criados.push(fonte, cap);
        const sink = nos.find((n) => n.info.props['node.name'] === 'tela_jogo');
        if (sink !== undefined && !opcoes.entradaNuncaLiga) links.push({ id: proximoId++, saida: sink.id, entrada: cap.id });
      } else {
        const fonte = no('tela_sistema_mic', 'Audio/Source');
        const cap = no('tela_sistema_cap', 'Stream/Input/Audio');
        criados.push(fonte, cap);
        if (!opcoes.entradaNuncaLiga) links.push({ id: proximoId++, saida: saidaReal, entrada: cap.id });
      }
      nos.push(...criados);
      let vivo = true;
      const saiu: Array<(c: number | null) => void> = [];
      const sumir = (codigo: number | null): void => {
        if (!vivo) return;
        vivo = false;
        const ids = new Set(criados.map((n) => n.id));
        for (const id of ids) {
          const i = nos.findIndex((n) => n.id === id);
          if (i >= 0) nos.splice(i, 1);
        }
        links = links.filter((l) => !ids.has(l.saida) && !ids.has(l.entrada));
        // Quem estava no sink volta ao padrão: o alvo deixou de existir.
        for (const n of nos) if (n.info.props['media.class'] === 'Stream/Output/Audio') ligar(n.id);
        for (const o of saiu) o(codigo);
      };
      mortes.push(() => sumir(null));
      return {
        kill: (sinal) => {
          kills.push(sinal);
          if (sinal === 'SIGTERM' && !opcoes.ignoraSigterm) sumir(0);
          if (sinal === 'SIGKILL') sumir(137);
          return true;
        },
        aoSair: (o) => saiu.push(o),
      };
    },
    agendar: () => () => undefined,
    esperar: () => Promise.resolve(),
    encerrarOrfaos: () => {
      registro.push('encerrarOrfaos');
      return 2;
    },
    pidsDoTela: () => new Set<number>(),
  };

  return {
    efeitos,
    registro,
    meta,
    kills: () => kills,
    sinkVivo: () => nos.some((n) => n.info.props['node.name'] === 'tela_jogo'),
    nosNossos: () => nos.filter((n) => String(n.info.props['node.name'] ?? '').startsWith('tela_')).map((n) => n.info.props['node.name']),
    /** Mata só o primeiro processo (o do sink): o da fonte virtual fica de pé, como numa queda parcial. */
    morrer: () => mortes[0]?.(),
    destinoPorNome: (nome: string) => {
      const n = nos.find((x) => x.info.props['node.name'] === nome);
      const l = links.find((x) => x.saida === n?.id);
      return nos.find((x) => x.id === l?.entrada)?.info.props['node.name'];
    },
    destinoDoStream: (stream: number) => {
      const l = links.find((x) => x.saida === stream);
      return nos.find((n) => n.id === l?.entrada)?.info.props['node.name'];
    },
    novoStream(app: string, pid: number, binario?: string): number {
      const id = proximoId++;
      nos.push({ id, type: 'PipeWire:Interface:Node', info: { state: 'running', props: { 'node.name': 'pw-play', 'media.class': 'Stream/Output/Audio', 'application.name': app, 'application.process.id': pid, ...(binario === undefined ? {} : { 'application.process.binary': binario }) } } });
      ligar(id);
      return id;
    },
    sumirStream(id: number): void {
      nos.splice(nos.findIndex((n) => n.id === id), 1);
      links = links.filter((l) => l.saida !== id);
    },
    fixarAlvo(stream: number, alvo: string): void {
      meta.push({ subject: stream, key: 'target.object', type: 'Spa:String', value: alvo });
    },
  };
}

const REAL = 'alsa_output.pci-0000_00_1f.3.analog-stereo';
const saidas = () => {
  const eventos: string[] = [];
  return { eventos, s: { encerrou: (f: { motivo: string }) => eventos.push(`encerrou:${f.motivo}`), mudou: (e: { fase: string; tocando?: boolean }) => eventos.push(`mudou:${e.fase}:${String(e.tocando)}`) } };
};

describe('SomDoJogoLinux.iniciar', () => {
  it('move só o app escolhido para o sink e deixa a call onde estava', async () => {
    const pw = pwFalso();
    const som = new SomDoJogoLinux(pw.efeitos);
    const r = await som.iniciar('pid:4242', saidas().s);
    expect(r).toEqual({ ok: true, value: { app: 'Jogo-Exemplo', descricao: 'Tela-Jogo-Entrada' } });
    expect(pw.destinoDoStream(97)).toBe('tela_jogo');
    expect(pw.destinoDoStream(85)).toBe(REAL);
    expect(som.fase()).toEqual({ fase: 'ativo', app: 'Jogo-Exemplo', tocando: true, modo: 'jogo' });
    // E a página tem o que capturar: a fonte virtual, não o monitor (o Chromium não lista monitores).
    expect(pw.nosNossos()).toContain('tela_jogo_mic');
    // O jogador segue ouvindo: o retorno do sink está ligado à saída real.
    expect(pw.destinoPorNome('tela_jogo_retorno')).toBe(REAL);
  });

  it('usa o retorno na saída padrão (seguindo-a) quando o jogo toca nela', async () => {
    const pw = pwFalso();
    await new SomDoJogoLinux(pw.efeitos).iniciar('pid:4242', saidas().s);
    expect(pw.registro.filter((l) => l.startsWith('spawn'))).toEqual(['spawn pw-loopback tela_jogo_lb', 'spawn pw-loopback tela_jogo_mic_lb']);
    // O sink é criado SEM `target.object` — o argumento do `-o` é só o nome do retorno.
    expect(pw.registro.join('\n')).not.toContain('target.object=');
  });

  it('app que não está tocando mais: APP_NAO_ENCONTRADO, sem criar sink', async () => {
    const pw = pwFalso();
    const som = new SomDoJogoLinux(pw.efeitos);
    expect(await som.iniciar('pid:1', saidas().s)).toEqual({ ok: false, error: 'APP_NAO_ENCONTRADO' });
    expect(pw.sinkVivo()).toBe(false);
    expect(som.fase().fase).toBe('ocioso');
  });

  it('sem PipeWire respondendo: INDISPONIVEL', async () => {
    const pw = pwFalso({ semDump: true });
    expect(await new SomDoJogoLinux(pw.efeitos).iniciar('pid:4242', saidas().s)).toEqual({ ok: false, error: 'INDISPONIVEL' });
  });

  it('retorno que não chega numa saída: FALHOU, o jogo nunca é movido e o sink é derrubado', async () => {
    const pw = pwFalso({ retornoNuncaLiga: true });
    const som = new SomDoJogoLinux(pw.efeitos);
    expect(await som.iniciar('pid:4242', saidas().s)).toEqual({ ok: false, error: 'FALHOU' });
    expect(pw.destinoDoStream(97)).toBe(REAL);
    expect(pw.sinkVivo()).toBe(false);
    expect(som.fase().fase).toBe('ocioso');
  });

  it('uma segunda sessão enquanto há uma: OCUPADO', async () => {
    const pw = pwFalso();
    const som = new SomDoJogoLinux(pw.efeitos);
    await som.iniciar('pid:4242', saidas().s);
    expect(await som.iniciar('pid:4343', saidas().s)).toEqual({ ok: false, error: 'OCUPADO' });
  });
});


describe('SomDoJogoLinux: a fonte virtual', () => {
  it('a fonte que não liga: FALHOU, o jogo nunca é movido, os DOIS processos caem', async () => {
    const pw = pwFalso({ entradaNuncaLiga: true });
    const som = new SomDoJogoLinux(pw.efeitos);
    expect(await som.iniciar('pid:4242', saidas().s)).toEqual({ ok: false, error: 'FALHOU' });
    expect(pw.destinoDoStream(97)).toBe(REAL);
    expect(pw.nosNossos()).toEqual([]);
    expect(som.fase().fase).toBe('ocioso');
  });

  it('parar derruba a fonte antes do sink e não deixa nada nosso no grafo', async () => {
    const pw = pwFalso();
    const som = new SomDoJogoLinux(pw.efeitos);
    await som.iniciar('pid:4242', saidas().s);
    expect(pw.nosNossos()).toEqual(expect.arrayContaining(['tela_jogo', 'tela_jogo_retorno', 'tela_jogo_mic', 'tela_jogo_mic_cap']));
    await som.parar();
    expect(pw.nosNossos()).toEqual([]);
  });

  it('processo que ignora o SIGTERM leva SIGKILL', async () => {
    const pw = pwFalso({ ignoraSigterm: true });
    const som = new SomDoJogoLinux(pw.efeitos);
    await som.iniciar('pid:4242', saidas().s);
    await som.parar();
    expect(pw.kills()).toContain('SIGKILL');
    expect(pw.nosNossos()).toEqual([]);
  });

  it('só o processo do sink morrer: avisa e derruba a fonte que ficou', async () => {
    const pw = pwFalso();
    const { s, eventos } = saidas();
    const som = new SomDoJogoLinux(pw.efeitos);
    await som.iniciar('pid:4242', s);
    pw.morrer();
    await new Promise((r) => setTimeout(r, 0));
    expect(eventos).toEqual(['encerrou:SINK_CAIU']);
    expect(pw.nosNossos()).toEqual([]);
  });
});

describe('SomDoJogoLinux.iniciarSistema', () => {
  it('cria só a fonte virtual do monitor da saída padrão e não move ninguém', async () => {
    const pw = pwFalso();
    const som = new SomDoJogoLinux(pw.efeitos);
    expect(await som.iniciarSistema(saidas().s)).toEqual({ ok: true, value: { descricao: 'Tela-Sistema-Entrada' } });
    expect(pw.nosNossos()).toEqual(expect.arrayContaining(['tela_sistema_mic', 'tela_sistema_cap']));
    expect(pw.nosNossos()).not.toContain('tela_jogo');
    expect(pw.registro.some((l) => l.startsWith('pw-metadata'))).toBe(false);
    expect(som.fase()).toEqual({ fase: 'ativo', app: 'sistema', tocando: true, modo: 'sistema' });
  });

  it('parar remove a fonte', async () => {
    const pw = pwFalso();
    const som = new SomDoJogoLinux(pw.efeitos);
    await som.iniciarSistema(saidas().s);
    await som.parar();
    expect(pw.nosNossos()).toEqual([]);
    expect(som.fase().fase).toBe('ocioso');
  });

  it('não coexiste com o "só o jogo": uma captura por vez', async () => {
    const pw = pwFalso();
    const som = new SomDoJogoLinux(pw.efeitos);
    await som.iniciarSistema(saidas().s);
    expect(await som.iniciar('pid:4242', saidas().s)).toEqual({ ok: false, error: 'OCUPADO' });
    expect(await som.iniciarSistema(saidas().s)).toEqual({ ok: false, error: 'OCUPADO' });
  });

  it('a fonte não liga: FALHOU e nada sobra', async () => {
    const pw = pwFalso({ entradaNuncaLiga: true });
    const som = new SomDoJogoLinux(pw.efeitos);
    expect(await som.iniciarSistema(saidas().s)).toEqual({ ok: false, error: 'FALHOU' });
    expect(pw.nosNossos()).toEqual([]);
  });

  it('sem PipeWire respondendo: INDISPONIVEL', async () => {
    expect(await new SomDoJogoLinux(pwFalso({ semDump: true }).efeitos).iniciarSistema(saidas().s)).toEqual({ ok: false, error: 'INDISPONIVEL' });
  });

  it('a fonte do sistema morrer avisa; a captura do jogo não é varrida no modo sistema', async () => {
    const pw = pwFalso();
    const { s, eventos } = saidas();
    const som = new SomDoJogoLinux(pw.efeitos);
    await som.iniciarSistema(s);
    pw.morrer();
    await new Promise((r) => setTimeout(r, 0));
    expect(eventos).toEqual(['encerrou:SINK_CAIU']);
  });
});

describe('SomDoJogoLinux.parar', () => {
  it('devolve o jogo à saída real e remove o sink', async () => {
    const pw = pwFalso();
    const som = new SomDoJogoLinux(pw.efeitos);
    await som.iniciar('pid:4242', saidas().s);
    await som.parar();
    expect(pw.destinoDoStream(97)).toBe(REAL);
    expect(pw.meta.some((m) => m.key === 'target.object')).toBe(false);
    expect(pw.sinkVivo()).toBe(false);
    expect(som.fase().fase).toBe('ocioso');
  });

  it('restaura o alvo que a pessoa tinha fixado, não o padrão', async () => {
    const pw = pwFalso();
    pw.fixarAlvo(97, REAL);
    const som = new SomDoJogoLinux(pw.efeitos);
    await som.iniciar('pid:4242', saidas().s);
    expect(pw.destinoDoStream(97)).toBe('tela_jogo');
    await som.parar();
    expect(pw.meta.find((m) => m.subject === 97 && m.key === 'target.object')?.value).toBe(REAL);
    expect(pw.destinoDoStream(97)).toBe(REAL);
  });

  it('é idempotente e não toca em nada se não há sessão', async () => {
    const pw = pwFalso();
    const som = new SomDoJogoLinux(pw.efeitos);
    await som.parar();
    await som.parar();
    expect(pw.registro).toEqual([]);
  });

  it('não tenta restaurar um stream que o app já fechou', async () => {
    const pw = pwFalso();
    const som = new SomDoJogoLinux(pw.efeitos);
    await som.iniciar('pid:4242', saidas().s);
    pw.sumirStream(97);
    const antes = pw.registro.length;
    await som.parar();
    expect(pw.registro.slice(antes).filter((l) => l.startsWith('pw-metadata'))).toEqual([]);
  });
});

describe('SomDoJogoLinux: ao vivo', () => {
  it('o pw-loopback morrendo restaura o jogo e avisa uma vez', async () => {
    const pw = pwFalso();
    const { s, eventos } = saidas();
    const som = new SomDoJogoLinux(pw.efeitos);
    await som.iniciar('pid:4242', s);
    pw.morrer();
    await new Promise((r) => setTimeout(r, 0));
    expect(eventos).toEqual(['encerrou:SINK_CAIU']);
    expect(pw.meta.some((m) => m.key === 'target.object')).toBe(false);
    expect(pw.destinoDoStream(97)).toBe(REAL);
    expect(som.fase().fase).toBe('ocioso');
  });

  it('um stream novo do mesmo app (outro nível do jogo) entra no sink na próxima varredura', async () => {
    let tique: (() => void) | null = null;
    const pw = pwFalso();
    pw.efeitos.agendar = (fn) => {
      tique = fn;
      return () => {
        tique = null;
      };
    };
    const som = new SomDoJogoLinux(pw.efeitos);
    await som.iniciar('pid:4242', saidas().s);
    const novo = pw.novoStream('Jogo-Exemplo', 4242);
    expect(pw.destinoDoStream(novo)).toBe(REAL);
    tique!();
    await new Promise((r) => setTimeout(r, 0));
    expect(pw.destinoDoStream(novo)).toBe('tela_jogo');
    await som.parar();
    expect(pw.destinoDoStream(novo)).toBe(REAL);
  });

  it('o app some e volta com outro pid: é reencontrado por nome e binário', async () => {
    let tique: (() => void) | null = null;
    const pw = pwFalso();
    pw.efeitos.agendar = (fn) => {
      tique = fn;
      return () => undefined;
    };
    const { s, eventos } = saidas();
    const som = new SomDoJogoLinux(pw.efeitos);
    await som.iniciar('pid:4242', s);
    pw.sumirStream(97);
    tique!();
    await new Promise((r) => setTimeout(r, 0));
    expect(som.fase()).toEqual({ fase: 'ativo', app: 'Jogo-Exemplo', tocando: false, modo: 'jogo' });
    const novo = pw.novoStream('Jogo-Exemplo', 9999, 'jogo-exemplo');
    tique!();
    await new Promise((r) => setTimeout(r, 0));
    expect(eventos).toContain('mudou:ativo:false');
    expect(pw.destinoDoStream(novo)).toBe('tela_jogo');
  });
});

describe('SomDoJogoLinux: restaurar sem prender o estado (S-13)', () => {
  it('um alvo anterior que o PipeWire gravou como "-d" não derruba o parar(): o stream volta ao padrão', async () => {
    const pw = pwFalso();
    pw.fixarAlvo(97, '-d');
    const som = new SomDoJogoLinux(pw.efeitos);
    expect(await som.iniciar('pid:4242', saidas().s)).toMatchObject({ ok: true });
    await expect(som.parar()).resolves.toBeUndefined();
    expect(som.fase()).toEqual({ fase: 'ocioso' });
    expect(pw.sinkVivo()).toBe(false);
    expect(pw.destinoDoStream(97)).toBe(REAL);
    // E nunca chegou ao pw-metadata como opção.
    expect(pw.registro.some((l) => l.includes('target.object -d'))).toBe(false);
  });

  it('mesmo com o pw-metadata lançando, parar() derruba os nós e volta a ocioso; dá para iniciar de novo', async () => {
    const pw = pwFalso();
    const som = new SomDoJogoLinux(pw.efeitos);
    await som.iniciar('pid:4242', saidas().s);
    const executar = pw.efeitos.executar;
    pw.efeitos.executar = (c) => (c.cmd === 'pw-metadata' ? Promise.reject(new Error('boom')) : executar(c));
    await expect(som.parar()).resolves.toBeUndefined();
    expect(som.fase()).toEqual({ fase: 'ocioso' });
    expect(pw.sinkVivo()).toBe(false);
    pw.efeitos.executar = executar;
    expect(await som.iniciar('pid:4242', saidas().s)).toMatchObject({ ok: true });
  });

  it('o kill do processo lançando também não prende o estado', async () => {
    const pw = pwFalso();
    const iniciarSink = pw.efeitos.iniciarSink;
    pw.efeitos.iniciarSink = (c) => ({ ...iniciarSink(c), kill: () => { throw new Error('ESRCH'); } });
    const som = new SomDoJogoLinux(pw.efeitos);
    await som.iniciar('pid:4242', saidas().s);
    await expect(som.parar()).resolves.toBeUndefined();
    expect(som.fase()).toEqual({ fase: 'ocioso' });
  });
});

describe('SomDoJogoLinux: resíduos e ferramentas', () => {
  it('limparResiduos mata o pw-loopback órfão e apaga os metadados que apontam para o sink', async () => {
    const pw = pwFalso();
    const som = new SomDoJogoLinux(pw.efeitos);
    await som.iniciar('pid:4242', saidas().s);
    // Simula o app morto: um novo SomDoJogoLinux (nova execução) sobre o mesmo PipeWire.
    const nova = new SomDoJogoLinux(pw.efeitos);
    // Dois pw-loopback órfãos (sink e fonte) e um stream ainda apontando para o sink.
    expect(await nova.limparResiduos()).toBe(3); // 2 órfãos do registro + 1 stream
    // Os órfãos vêm do registro do PRÓPRIO app (efeito), nunca do grafo do PipeWire (S-12).
    expect(pw.registro).toContain('encerrarOrfaos');
    expect(pw.meta.some((m) => m.key === 'target.object')).toBe(false);
  });

  it('não limpa nada com uma sessão em curso', async () => {
    const pw = pwFalso();
    const som = new SomDoJogoLinux(pw.efeitos);
    await som.iniciar('pid:4242', saidas().s);
    expect(await som.limparResiduos()).toBe(0);
  });

  it('disponibilidade lista as ferramentas que faltam', async () => {
    const pw = pwFalso();
    const som = new SomDoJogoLinux({ ...pw.efeitos, executar: (c) => Promise.resolve({ codigo: c.cmd === 'pw-loopback' ? null : 0, saida: '' }) });
    const d = await som.disponibilidade();
    expect(d.disponivel).toBe(false);
    expect(d.motivo).toContain('pw-loopback');
    expect((await new SomDoJogoLinux(pw.efeitos).disponibilidade()).disponivel).toBe(true);
  });

  it('listar devolve null se o PipeWire não respondeu', async () => {
    expect(await new SomDoJogoLinux(pwFalso({ semDump: true }).efeitos).listar()).toBeNull();
    expect((await new SomDoJogoLinux(pwFalso().efeitos).listar())?.map((a) => a.nome)).toEqual(['Chamada-Voz', 'Jogo-Exemplo']);
  });
});

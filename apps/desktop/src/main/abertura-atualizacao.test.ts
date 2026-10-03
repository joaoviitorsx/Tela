import { describe, expect, it, vi } from 'vitest';
import {
  chamadaDaFase,
  deveMostrarAbertura,
  executarAbertura,
  tentativaDeInstalar,
  type FaseDaAbertura,
  HTML_DA_ABERTURA,
  PRAZO_DA_VERIFICACAO_MS,
  textoDaFase,
  TITULO_DE_PULAR,
} from './abertura-atualizacao.js';
import type { MotorDeAtualizacao } from './atualizador.js';

function adiada<T>() {
  let resolver: (v: T) => void = () => undefined;
  let rejeitar: (e: unknown) => void = () => undefined;
  const promessa = new Promise<T>((r, j) => {
    resolver = r;
    rejeitar = j;
  });
  return { promessa, resolver, rejeitar };
}

const tique = () => new Promise((r) => setTimeout(r, 0));

function montar(motor: Partial<MotorDeAtualizacao> = {}) {
  const fases: FaseDaAbertura[] = [];
  const timers: { fn: () => void; ms: number; vivo: boolean }[] = [];
  const pular = adiada<void>();
  const m: MotorDeAtualizacao = {
    verificar: vi.fn(async () => null),
    baixar: vi.fn(async () => '0.2.0'),
    cancelarDownload: vi.fn(),
    instalarAoSair: vi.fn(),
    instalarAgora: vi.fn(),
    ...motor,
  };
  const desfecho = executarAbertura({
    motor: m,
    aoMudar: (f) => fases.push(f),
    agendar: (fn, ms) => {
      const t = { fn, ms, vivo: true };
      timers.push(t);
      return () => {
        t.vivo = false;
      };
    },
    pulou: pular.promessa,
    log: { info: () => undefined, erro: () => undefined },
  });
  const esgotarPrazo = () => {
    for (const t of timers) if (t.vivo) t.fn();
  };
  return { desfecho, fases, motor: m, pular: () => pular.resolver(), esgotarPrazo, timers };
}

describe('deveMostrarAbertura', () => {
  it('só com atualização automática, ligada, e o app aberto por alguém', () => {
    const ok = { modo: 'automatica', automatico: true, oculto: false, tentativaPendente: false } as const;
    expect(deveMostrarAbertura(ok)).toBe(true);
    expect(deveMostrarAbertura({ ...ok, automatico: false })).toBe(false);
    expect(deveMostrarAbertura({ ...ok, oculto: true })).toBe(false);
    expect(deveMostrarAbertura({ ...ok, modo: 'avisar' })).toBe(false);
    expect(deveMostrarAbertura({ ...ok, modo: 'desligada' })).toBe(false);
    // Instalação tentada e o app voltou na versão antiga: sem laço de reinício.
    expect(deveMostrarAbertura({ ...ok, tentativaPendente: true })).toBe(false);
  });
});

describe('executarAbertura', () => {
  it('em dia: procura e abre', async () => {
    const { desfecho, fases, motor } = montar();
    await expect(desfecho).resolves.toBe('abrir');
    expect(fases).toEqual([{ tipo: 'procurando' }]);
    expect(motor.baixar).not.toHaveBeenCalled();
  });

  it('versão nova: baixa com progresso, instala e não abre a janela', async () => {
    const { desfecho, fases, motor } = montar({
      verificar: async () => ({ versao: '0.2.0', pagina: 'https://x' }),
      baixar: async (progresso) => {
        progresso(41.6);
        progresso(100);
        return '0.2.0';
      },
    });
    await expect(desfecho).resolves.toBe('instalando');
    expect(fases).toEqual([
      { tipo: 'procurando' },
      { tipo: 'baixando', percentual: 0, versao: '0.2.0' },
      { tipo: 'baixando', percentual: 42, versao: '0.2.0' },
      { tipo: 'baixando', percentual: 100, versao: '0.2.0' },
      { tipo: 'instalando', versao: '0.2.0' },
    ]);
    expect(motor.instalarAgora).toHaveBeenCalledOnce();
  });

  it('verificação lenta: no prazo, abre sem esperar', async () => {
    const lenta = adiada<null>();
    const { desfecho, esgotarPrazo, timers } = montar({ verificar: () => lenta.promessa });
    await tique();
    expect(timers[0]?.ms).toBe(PRAZO_DA_VERIFICACAO_MS);
    esgotarPrazo();
    await expect(desfecho).resolves.toBe('abrir');
  });

  it('sem rede (erro na verificação): abre', async () => {
    const { desfecho } = montar({ verificar: async () => Promise.reject(new Error('offline')) });
    await expect(desfecho).resolves.toBe('abrir');
  });

  it('ABRIR SEM ATUALIZAR no meio do download: cancela e abre', async () => {
    const download = adiada<string | null>();
    const { desfecho, pular, motor, fases } = montar({
      verificar: async () => ({ versao: '0.2.0', pagina: 'https://x' }),
      baixar: () => download.promessa,
    });
    await tique();
    expect(fases.at(-1)?.tipo).toBe('baixando');
    pular();
    await expect(desfecho).resolves.toBe('abrir');
    expect(motor.cancelarDownload).toHaveBeenCalledOnce();
    expect(motor.instalarAgora).not.toHaveBeenCalled();
  });

  it('download falha ou é cancelado: abre', async () => {
    const a = montar({ verificar: async () => ({ versao: '0.2.0', pagina: 'x' }), baixar: async () => Promise.reject(new Error('hash')) });
    await expect(a.desfecho).resolves.toBe('abrir');
    const b = montar({ verificar: async () => ({ versao: '0.2.0', pagina: 'x' }), baixar: async () => null });
    await expect(b.desfecho).resolves.toBe('abrir');
  });

  it('instalar que lança: abre em vez de deixar a pessoa sem app', async () => {
    const { desfecho } = montar({
      verificar: async () => ({ versao: '0.2.0', pagina: 'x' }),
      instalarAgora: () => {
        throw new Error('sem permissão');
      },
    });
    await expect(desfecho).resolves.toBe('abrir');
  });

  it('o prazo é cancelado quando a resposta chega a tempo', async () => {
    const { desfecho, timers } = montar();
    await desfecho;
    expect(timers.every((t) => !t.vivo)).toBe(true);
  });
});

describe('página da abertura', () => {
  it('texto de cada fase; ABRIR SEM ATUALIZAR só no download', () => {
    expect(textoDaFase({ tipo: 'procurando' })).toEqual({ tipo: 'procurando', linha: 'Procurando atualização…', progresso: null, podePular: false });
    // O percentual não entra na linha viva (o leitor de tela anunciaria a cada segundo).
    expect(textoDaFase({ tipo: 'baixando', percentual: 42, versao: '0.2.0' }).linha).toBe('Baixando a versão 0.2.0');
    expect(textoDaFase({ tipo: 'baixando', percentual: 42, versao: '0.2.0' }).podePular).toBe(true);
    expect(textoDaFase({ tipo: 'instalando', versao: '0.2.0' }).podePular).toBe(false);
  });

  it('a chamada serializa por JSON: uma versão maliciosa não vira código', () => {
    const c = chamadaDaFase({ tipo: 'baixando', percentual: 1, versao: '"); alert(1); ("' });
    expect(c.startsWith('fase({')).toBe(true);
    expect(() => JSON.parse(c.slice('fase('.length, -1))).not.toThrow();
  });

  it('CSP fechada, sem rede, e o botão sinaliza pelo título', () => {
    expect(HTML_DA_ABERTURA).toContain("default-src 'none'");
    // O único endereço permitido é o namespace do SVG (não é rede).
    expect(HTML_DA_ABERTURA.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:\/\//);
    expect(HTML_DA_ABERTURA).toContain(JSON.stringify(TITULO_DE_PULAR));
  });
});

describe('tentativaDeInstalar', () => {
  it('voltou na mesma versão de antes: pendente (a instalação falhou); outra versão: apagar a marca', () => {
    expect(tentativaDeInstalar({ de: '0.1.0', para: '0.2.0' }, '0.1.0')).toEqual({ pendente: true, apagar: false });
    expect(tentativaDeInstalar({ de: '0.1.0', para: '0.2.0' }, '0.2.0')).toEqual({ pendente: false, apagar: true });
    expect(tentativaDeInstalar(null, '0.1.0')).toEqual({ pendente: false, apagar: false });
    expect(tentativaDeInstalar({ lixo: 1 }, '0.1.0')).toEqual({ pendente: false, apagar: true });
  });
});

describe('executarAbertura — instalar só quando pode', () => {
  it('ao vivo (ou automático desligado): baixa e NÃO instala; abre', async () => {
    const instalarAgora = vi.fn();
    const antesDeInstalar = vi.fn();
    const r = await executarAbertura({
      motor: { verificar: async () => ({ versao: '0.2.0', pagina: 'x' }), baixar: async () => '0.2.0', cancelarDownload: vi.fn(), instalarAoSair: vi.fn(), instalarAgora },
      aoMudar: () => undefined,
      agendar: () => () => undefined,
      pulou: new Promise(() => undefined),
      log: { info: () => undefined, erro: () => undefined },
      podeInstalar: () => false,
      antesDeInstalar,
    });
    expect(r).toBe('abrir');
    expect(instalarAgora).not.toHaveBeenCalled();
    expect(antesDeInstalar).not.toHaveBeenCalled();
  });

  it('pode: grava a marca ANTES de instalar', async () => {
    const ordem: string[] = [];
    await executarAbertura({
      motor: { verificar: async () => ({ versao: '0.2.0', pagina: 'x' }), baixar: async () => '0.2.0', cancelarDownload: vi.fn(), instalarAoSair: vi.fn(), instalarAgora: () => ordem.push('instalar') },
      aoMudar: () => undefined,
      agendar: () => () => undefined,
      pulou: new Promise(() => undefined),
      log: { info: () => undefined, erro: () => undefined },
      podeInstalar: () => true,
      antesDeInstalar: (v) => ordem.push(`marca ${v}`),
    });
    expect(ordem).toEqual(['marca 0.2.0', 'instalar']);
  });
});

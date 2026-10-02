import { describe, expect, it, vi } from 'vitest';
import {
  ATRASO_DA_PRIMEIRA_VERIFICACAO_MS,
  criarAtualizador,
  type Dependencias,
  INTERVALO_ENTRE_VERIFICACOES_MS,
  type MotorDeAtualizacao,
} from './atualizador.js';
import type { EstadoDaAtualizacao } from './atualizacao-politica.js';

/** Relógio na mão: `avancar(ms)` dispara o que venceu, na ordem. */
function relogio() {
  let agora = 0;
  const pendentes: { em: number; fn: () => void; vivo: boolean }[] = [];
  return {
    agora: () => agora,
    agendar: (fn: () => void, ms: number) => {
      const item = { em: agora + ms, fn, vivo: true };
      pendentes.push(item);
      return () => {
        item.vivo = false;
      };
    },
    avancar: (ms: number) => {
      const alvo = agora + ms;
      for (;;) {
        const proximo = pendentes.filter((p) => p.vivo && p.em <= alvo).sort((a, b) => a.em - b.em)[0];
        if (proximo === undefined) break;
        proximo.vivo = false;
        agora = proximo.em;
        proximo.fn();
      }
      agora = alvo;
    },
  };
}

/** Uma promessa que o teste resolve quando quiser. */
function adiada<T>() {
  let resolver: (v: T) => void = () => undefined;
  let rejeitar: (e: unknown) => void = () => undefined;
  const promessa = new Promise<T>((res, rej) => {
    resolver = res;
    rejeitar = rej;
  });
  return { promessa, resolver, rejeitar };
}

const solta = () => new Promise<void>((r) => setImmediate(r));

function montar(sobre: Partial<Pick<Dependencias, 'modo' | 'automatico'>> = {}) {
  const rel = relogio();
  let verificacao = adiada<{ versao: string; pagina: string } | null>();
  let download = adiada<string | null>();
  let progresso: (p: number) => void = () => undefined;
  const motor: MotorDeAtualizacao = {
    verificar: vi.fn(() => verificacao.promessa),
    baixar: vi.fn((aoProgresso: (p: number) => void) => {
      progresso = aoProgresso;
      return download.promessa;
    }),
    cancelarDownload: vi.fn(),
    instalarAoSair: vi.fn(),
    instalarAgora: vi.fn(),
  };
  const vistas: EstadoDaAtualizacao[] = [];
  const erros: string[] = [];
  const a = criarAtualizador({
    modo: sobre.modo ?? 'automatica',
    automatico: sobre.automatico ?? true,
    motor,
    agora: rel.agora,
    agendar: rel.agendar,
    aoMudar: (v) => vistas.push(v),
    log: { info: () => undefined, erro: (m) => erros.push(m) },
  });
  return {
    a,
    rel,
    motor,
    vistas,
    erros,
    progresso: (p: number) => progresso(p),
    verificacao: () => verificacao,
    download: () => download,
    novaVerificacao: () => (verificacao = adiada()),
    novoDownload: () => (download = adiada()),
  };
}

const NOVA = { versao: '0.1.0-beta.7', pagina: 'https://github.com/joaoviitorsx/Tela/releases/tag/desktop-v0.1.0-beta.7' };

describe('atualizador — agenda', () => {
  it('a primeira verificação é 30 s depois de abrir, e as seguintes a cada 6 h', async () => {
    const t = montar();
    t.a.iniciar();
    t.rel.avancar(ATRASO_DA_PRIMEIRA_VERIFICACAO_MS - 1);
    expect(t.motor.verificar).not.toHaveBeenCalled();
    t.rel.avancar(1);
    expect(t.motor.verificar).toHaveBeenCalledTimes(1);
    t.verificacao().resolver(null);
    await solta();
    t.rel.avancar(INTERVALO_ENTRE_VERIFICACOES_MS - 1);
    expect(t.motor.verificar).toHaveBeenCalledTimes(1);
    t.rel.avancar(1);
    expect(t.motor.verificar).toHaveBeenCalledTimes(2);
  });

  it('ao vivo, o tique não verifica (e a próxima volta tenta de novo)', async () => {
    const t = montar();
    t.a.iniciar();
    t.a.aoVivo(true);
    t.rel.avancar(ATRASO_DA_PRIMEIRA_VERIFICACAO_MS);
    expect(t.motor.verificar).not.toHaveBeenCalled();
    t.a.aoVivo(false);
    t.rel.avancar(INTERVALO_ENTRE_VERIFICACOES_MS);
    expect(t.motor.verificar).toHaveBeenCalledTimes(1);
  });

  it('desligada não agenda nada; parar cancela', () => {
    const d = montar({ modo: 'desligada' });
    d.a.iniciar();
    d.rel.avancar(ATRASO_DA_PRIMEIRA_VERIFICACAO_MS);
    expect(d.motor.verificar).not.toHaveBeenCalled();
    const t = montar();
    t.a.iniciar();
    t.a.parar();
    t.rel.avancar(ATRASO_DA_PRIMEIRA_VERIFICACAO_MS);
    expect(t.motor.verificar).not.toHaveBeenCalled();
  });
});

describe('atualizador — do achado ao instalado', () => {
  it('achou, baixa com progresso, fica pronta; instala ao sair já ligado e reiniciar chama o motor', async () => {
    const t = montar();
    t.a.verificarAgora();
    t.verificacao().resolver(NOVA);
    await solta();
    expect(t.motor.baixar).toHaveBeenCalledTimes(1);
    t.progresso(42);
    expect(t.a.vista()).toMatchObject({ fase: 'baixando', progresso: 42 });
    t.download().resolver('0.1.0-beta.7');
    await solta();
    expect(t.a.vista()).toMatchObject({ fase: 'pronta', versaoNova: '0.1.0-beta.7', podeReiniciar: true });
    expect(t.motor.instalarAoSair).toHaveBeenCalledWith(true);
    expect(t.motor.instalarAgora).not.toHaveBeenCalled();
    t.a.reiniciar();
    expect(t.motor.instalarAgora).toHaveBeenCalledTimes(1);
  });

  it('download que termina ao vivo espera: reiniciar é recusado até a transmissão acabar', async () => {
    const t = montar();
    t.a.verificarAgora();
    t.verificacao().resolver(NOVA);
    await solta();
    // O download termina e SÓ DEPOIS a página avisa que foi ao ar.
    t.download().resolver('0.1.0-beta.7');
    await solta();
    t.a.aoVivo(true);
    t.a.reiniciar();
    expect(t.motor.instalarAgora).not.toHaveBeenCalled();
    expect(t.a.vista().podeReiniciar).toBe(false);
    t.a.aoVivo(false);
    t.a.reiniciar();
    expect(t.motor.instalarAgora).toHaveBeenCalledTimes(1);
  });

  it('entrou no ar durante o download: cancela no motor, e a promessa cancelada (null) não vira erro nem "baixada"', async () => {
    const t = montar();
    t.a.verificarAgora();
    t.verificacao().resolver(NOVA);
    await solta();
    t.a.aoVivo(true);
    expect(t.motor.cancelarDownload).toHaveBeenCalledTimes(1);
    t.download().resolver(null);
    await solta();
    expect(t.a.vista()).toMatchObject({ fase: 'disponivel', adiada: true, erro: null });
    t.novoDownload();
    t.a.aoVivo(false);
    expect(t.motor.baixar).toHaveBeenCalledTimes(2);
  });

  it('falha de rede: vai ao log, vira a linha "Última verificação" e nunca lança', async () => {
    const t = montar();
    t.rel.avancar(5000);
    t.a.verificarAgora();
    t.verificacao().rejeitar(new Error('net::ERR_INTERNET_DISCONNECTED\n  at x'));
    await solta();
    expect(t.erros).toContain('falha na atualização');
    expect(t.a.vista()).toMatchObject({ fase: 'erro', erro: 'net::ERR_INTERNET_DISCONNECTED', ultimaVerificacaoMs: 5000 });
  });

  it('o ajuste desligado cancela e tira o instalar-ao-sair', async () => {
    const t = montar();
    t.a.verificarAgora();
    t.verificacao().resolver(NOVA);
    await solta();
    t.download().resolver('0.1.0-beta.7');
    await solta();
    t.a.automatico(false);
    expect(t.motor.instalarAoSair).toHaveBeenLastCalledWith(false);
  });

  it('deb/rpm: só avisa (com a página) e o motor nunca baixa', async () => {
    const t = montar({ modo: 'avisar' });
    t.a.verificarAgora();
    t.verificacao().resolver(NOVA);
    await solta();
    expect(t.motor.baixar).not.toHaveBeenCalled();
    expect(t.a.vista()).toMatchObject({ modo: 'avisar', fase: 'disponivel', pagina: NOVA.pagina });
  });

  it('só emite a vista quando algo muda', () => {
    const t = montar();
    t.a.aoVivo(false);
    t.a.automatico(true);
    expect(t.vistas).toHaveLength(0);
  });
});

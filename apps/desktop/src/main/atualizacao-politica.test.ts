import { describe, expect, it } from 'vitest';
import {
  type ComandoDaPolitica,
  type EstadoDaPolitica,
  type EventoDaPolitica,
  estadoInicial,
  projetar,
  reduzir,
} from './atualizacao-politica.js';

/** Aplica os eventos em ordem; devolve o estado final e TODOS os comandos emitidos. */
function rodar(inicial: EstadoDaPolitica, eventos: readonly EventoDaPolitica[]) {
  let estado = inicial;
  const comandos: ComandoDaPolitica[] = [];
  for (const e of eventos) {
    const t = reduzir(estado, e);
    estado = t.estado;
    comandos.push(...t.comandos);
  }
  return { estado, comandos };
}

const tipos = (c: readonly ComandoDaPolitica[]) => c.map((x) => x.tipo);
const auto = () => estadoInicial('automatica', true);
const achou = (rodada: number, versao: string | null = '0.1.0-beta.7'): EventoDaPolitica => ({
  tipo: 'verificacao',
  rodada,
  versao,
  pagina: versao === null ? null : 'https://github.com/x',
  em: 1000,
});
const baixada = (rodada: number): EventoDaPolitica => ({ tipo: 'baixada', rodada, versao: '0.1.0-beta.7' });

describe('política de atualização — fora do ar', () => {
  it('tique verifica; achou versão nova baixa; terminou, fica pronta e liga o instalar-ao-sair', () => {
    const r = rodar(auto(), [{ tipo: 'tique' }, achou(1), { tipo: 'progresso', rodada: 2, percentual: 41.6 }]);
    expect(tipos(r.comandos)).toEqual(['verificar', 'baixar']);
    expect(r.estado.fase).toBe('baixando');
    expect(projetar(r.estado)).toMatchObject({ fase: 'baixando', progresso: 42, podeVerificar: false });

    const fim = rodar(r.estado, [baixada(2)]);
    expect(fim.comandos).toEqual([{ tipo: 'instalar-ao-sair', ligado: true }]);
    expect(projetar(fim.estado)).toMatchObject({ fase: 'pronta', versaoNova: '0.1.0-beta.7', podeReiniciar: true });
  });

  it('em dia: volta a ocioso, registra a verificação e não baixa', () => {
    const r = rodar(auto(), [{ tipo: 'tique' }, achou(1, null)]);
    expect(tipos(r.comandos)).toEqual(['verificar']);
    expect(projetar(r.estado)).toMatchObject({ fase: 'em-dia', ultimaVerificacaoMs: 1000, erro: null });
  });

  it('reiniciar com a atualização pronta manda instalar agora', () => {
    const pronta = rodar(auto(), [{ tipo: 'tique' }, achou(1), baixada(2)]).estado;
    expect(reduzir(pronta, { tipo: 'reiniciar' }).comandos).toEqual([{ tipo: 'instalar-agora' }]);
  });

  it('reiniciar sem nada pronto não faz nada', () => {
    expect(reduzir(auto(), { tipo: 'reiniciar' }).comandos).toEqual([]);
  });

  it('erro é silencioso: volta a ocioso, guarda a mensagem e a hora, e a próxima rodada tenta de novo', () => {
    const r = rodar(auto(), [{ tipo: 'tique' }, { tipo: 'erro', rodada: 1, mensagem: 'sem rede', em: 5 }]);
    expect(projetar(r.estado)).toMatchObject({ fase: 'erro', erro: 'sem rede', ultimaVerificacaoMs: 5, podeVerificar: true });
    expect(tipos(rodar(r.estado, [{ tipo: 'tique' }]).comandos)).toEqual(['verificar']);
  });

  it('evento de rodada velha é ignorado', () => {
    const r = rodar(auto(), [{ tipo: 'tique' }, achou(1), { tipo: 'progresso', rodada: 1, percentual: 90 }, baixada(1)]);
    expect(r.estado.fase).toBe('baixando');
    expect(r.estado.progresso).toBe(0);
  });
});

describe('política de atualização — ao vivo (nunca interrompe a transmissão)', () => {
  const noAr = (): EventoDaPolitica => ({ tipo: 'ao-vivo', noAr: true });
  const fora = (): EventoDaPolitica => ({ tipo: 'ao-vivo', noAr: false });

  it('ao vivo, nem o tique nem "verificar agora" verificam', () => {
    const r = rodar(auto(), [noAr(), { tipo: 'tique' }, { tipo: 'verificar-agora' }]);
    expect(r.comandos).toEqual([]);
    expect(projetar(r.estado).podeVerificar).toBe(false);
  });

  it('entrou no ar no meio do download: cancela, e retoma quando a transmissão acaba', () => {
    const baixando = rodar(auto(), [{ tipo: 'tique' }, achou(1)]);
    const vivo = rodar(baixando.estado, [noAr()]);
    expect(vivo.comandos).toEqual([{ tipo: 'cancelar-download' }]);
    expect(vivo.estado.fase).toBe('ocioso');
    expect(projetar(vivo.estado)).toMatchObject({ fase: 'disponivel', adiada: true });

    const retomou = rodar(vivo.estado, [fora()]);
    expect(retomou.comandos).toEqual([{ tipo: 'baixar', rodada: 4 }]);
    expect(retomou.estado.fase).toBe('baixando');
  });

  it('o que o download cancelado ainda disser (rodada velha) não atrapalha o download retomado', () => {
    const baixando = rodar(auto(), [{ tipo: 'tique' }, achou(1)]); // rodada 2 baixando
    const r = rodar(baixando.estado, [
      noAr(),
      fora(), // retoma: a rodada 4 (a 3 foi o cancelamento)
      { tipo: 'erro', rodada: 2, mensagem: 'cancelado', em: 9 },
      baixada(2),
    ]);
    expect(r.estado.fase).toBe('baixando');
    expect(r.estado.erro).toBeNull();
  });

  it('versão achada por uma verificação que terminou ao vivo não baixa; baixa ao sair do ar', () => {
    const r = rodar(auto(), [{ tipo: 'tique' }, noAr(), achou(1)]);
    expect(tipos(r.comandos)).toEqual(['verificar']);
    expect(projetar(r.estado)).toMatchObject({ fase: 'disponivel', adiada: true });
    expect(tipos(rodar(r.estado, [{ tipo: 'ao-vivo', noAr: false }]).comandos)).toEqual(['baixar']);
  });

  it('download que TERMINA ao vivo (já estava indo): pronta, sem REINICIAR; instala ao sair, e libera ao acabar', () => {
    // O download não é cancelado se já vai terminar na mesma rodada que o `ao-vivo` — o motor
    // pode concluir antes do cancelamento chegar. O reducer cancela no `ao-vivo`, então esta
    // situação é a de um download que acabou ANTES de o app ir ao ar:
    const pronta = rodar(auto(), [{ tipo: 'tique' }, achou(1), baixada(2)]).estado;
    const vivo = rodar(pronta, [noAr()]);
    expect(vivo.comandos).toEqual([]);
    expect(projetar(vivo.estado)).toMatchObject({ fase: 'pronta', podeReiniciar: false });
    expect(reduzir(vivo.estado, { tipo: 'reiniciar' }).comandos).toEqual([]);
    const livre = rodar(vivo.estado, [{ tipo: 'ao-vivo', noAr: false }]);
    expect(projetar(livre.estado).podeReiniciar).toBe(true);
    expect(reduzir(livre.estado, { tipo: 'reiniciar' }).comandos).toEqual([{ tipo: 'instalar-agora' }]);
  });
});

describe('política de atualização — o ajuste "Atualizar automaticamente"', () => {
  it('desligado, o tique não verifica; "verificar agora" verifica e baixa mesmo assim', () => {
    const off = estadoInicial('automatica', false);
    expect(reduzir(off, { tipo: 'tique' }).comandos).toEqual([]);
    const r = rodar(off, [{ tipo: 'verificar-agora' }, achou(1)]);
    expect(tipos(r.comandos)).toEqual(['verificar', 'baixar']);
  });

  it('desligar no meio de um download automático cancela; ligar de novo verifica', () => {
    const baixando = rodar(auto(), [{ tipo: 'tique' }, achou(1)]).estado;
    const off = reduzir(baixando, { tipo: 'automatico', ligado: false });
    expect(off.comandos).toEqual([{ tipo: 'cancelar-download' }]);
    const on = reduzir(off.estado, { tipo: 'automatico', ligado: true });
    expect(tipos(on.comandos)).toEqual(['baixar']); // a versão já é conhecida
  });

  it('desligar com a atualização já baixada tira o instalar-ao-sair', () => {
    const pronta = rodar(auto(), [{ tipo: 'tique' }, achou(1), baixada(2)]).estado;
    expect(reduzir(pronta, { tipo: 'automatico', ligado: false }).comandos).toEqual([
      { tipo: 'instalar-ao-sair', ligado: false },
    ]);
  });
});

describe('política de atualização — deb/rpm e desligada', () => {
  it('deb/rpm: verifica, avisa com a página, e NUNCA baixa', () => {
    const r = rodar(estadoInicial('avisar', true), [{ tipo: 'tique' }, achou(1)]);
    expect(tipos(r.comandos)).toEqual(['verificar']);
    expect(projetar(r.estado)).toMatchObject({
      modo: 'avisar',
      fase: 'disponivel',
      versaoNova: '0.1.0-beta.7',
      pagina: 'https://github.com/x',
      podeReiniciar: false,
    });
  });

  it('desligada: nada acontece, nem a pedido', () => {
    const r = rodar(estadoInicial('desligada', true), [{ tipo: 'tique' }, { tipo: 'verificar-agora' }]);
    expect(r.comandos).toEqual([]);
    expect(projetar(r.estado)).toMatchObject({ fase: 'desligada', podeVerificar: false });
  });
});

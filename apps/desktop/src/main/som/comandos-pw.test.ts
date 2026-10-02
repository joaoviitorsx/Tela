import { describe, expect, it } from 'vitest';
import { criarEntradaDoJogo, criarEntradaDoSistema, criarSink, moverParaSink, restaurarStream } from './comandos-pw.js';

describe('criarSink', () => {
  it('cria um sink Audio/Sink e deixa o retorno seguir a saída padrão', () => {
    const c = criarSink(null);
    expect(c.cmd).toBe('pw-loopback');
    expect(c.args).toContain('-i');
    const captura = c.args[c.args.indexOf('-i') + 1]!;
    expect(captura).toContain('media.class=Audio/Sink');
    expect(captura).toContain('node.name=tela_jogo ');
    const retorno = c.args[c.args.indexOf('-o') + 1]!;
    expect(retorno).toBe('node.name=tela_jogo_retorno');
  });

  it('fixa o retorno numa saída quando o jogador não usa a padrão', () => {
    const retorno = criarSink('bluez_output.00_00_00_00_00_00.1').args.at(-1)!;
    expect(retorno).toContain('target.object=bluez_output.00_00_00_00_00_00.1');
  });

  it('recusa um nome que abriria outra propriedade', () => {
    expect(() => criarSink('x node.name=y')).toThrow(RangeError);
    expect(() => criarSink('a"b')).toThrow(RangeError);
  });
});

describe('as fontes virtuais (o Chromium não lista monitores de sink)', () => {
  it('a do jogo captura o monitor do sink do Tela e vira uma Audio/Source', () => {
    const { cmd, args } = criarEntradaDoJogo();
    expect(cmd).toBe('pw-loopback');
    expect(args[args.indexOf('-C') + 1]).toBe('tela_jogo');
    expect(args[args.indexOf('-i') + 1]).toContain('stream.capture.sink=true');
    const saida = args[args.indexOf('-o') + 1]!;
    expect(saida).toContain('media.class=Audio/Source');
    expect(saida).toContain('node.name=tela_jogo_mic');
    expect(saida).toContain('node.description=Tela-Jogo-Entrada');
  });

  it('a do sistema NÃO fixa alvo: o monitor da saída padrão, seguindo a padrão', () => {
    const { args } = criarEntradaDoSistema();
    expect(args).not.toContain('-C');
    expect(args[args.indexOf('-i') + 1]).toContain('stream.capture.sink=true');
    expect(args[args.indexOf('-o') + 1]).toContain('node.description=Tela-Sistema-Entrada');
  });

  it('nenhum nome nosso escapa do prefixo que a limpeza reconhece', () => {
    for (const c of [criarSink(null), criarEntradaDoJogo(), criarEntradaDoSistema()]) {
      const nomes = c.args.join(' ').match(/node\.name=(\S+)/g) ?? [];
      expect(nomes.length).toBeGreaterThan(0);
      for (const n of nomes) expect(n).toMatch(/^node\.name=tela_(jogo|sistema)/);
    }
  });
});

describe('moverParaSink / restaurarStream', () => {
  it('move um stream pelo metadado default', () => {
    expect(moverParaSink(97).args).toEqual(['-n', 'default', '97', 'target.object', 'tela_jogo', 'Spa:String']);
  });

  it('restaurar sem alvo anterior apaga a chave', () => {
    expect(restaurarStream(97, null).args).toEqual(['-n', 'default', '-d', '97', 'target.object']);
  });

  it('restaurar com alvo anterior grava de volta o mesmo par', () => {
    expect(restaurarStream(97, { valor: 'fone.x', tipo: 'Spa:String' }).args).toEqual(['-n', 'default', '97', 'target.object', 'fone.x', 'Spa:String']);
    expect(restaurarStream(97, { valor: '55', tipo: 'Spa:Id' }).args.at(-1)).toBe('Spa:Id');
  });

  it('só aceita ids de nó inteiros', () => {
    for (const ruim of [-1, 1.5, Number.NaN, 2 ** 40]) expect(() => moverParaSink(ruim)).toThrow(RangeError);
  });
});

import { describe, expect, it } from 'vitest';
import { criarEntradaDoJogo, criarEntradaDoSistema, criarSink, moverParaSink, restaurarStream } from './comandos-pw.js';
import { NOS_DO_SISTEMA } from './grafo-pw.js';

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

  it('um nome de dispositivo real, com espaço, vai entre aspas: não abre outra propriedade (S-14)', () => {
    expect(criarSink('Fone USB').args.at(-1)).toBe('node.name=tela_jogo_retorno target.object="Fone USB"');
    // Tenta injetar `node.name=y`: continua UM valor, entre aspas.
    expect(criarSink('x node.name=y').args.at(-1)).toBe('node.name=tela_jogo_retorno target.object="x node.name=y"');
    expect(criarSink('a"b\\c').args.at(-1)).toBe('node.name=tela_jogo_retorno target.object="a\\"b\\\\c"');
  });

  it('recusa o que não é nome: controle, vazio, longo demais, `-` inicial', () => {
    for (const ruim of ['', 'a\nb', 'a\0b', '-d', '--help', 'x'.repeat(201)]) {
      expect(() => criarSink(ruim), JSON.stringify(ruim)).toThrow(RangeError);
    }
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

  it('a do sistema captura o monitor do sink Tela-Sistema — não o da saída padrão, onde a call toca', () => {
    const { args } = criarEntradaDoSistema();
    expect(args[args.indexOf('-C') + 1]).toBe('tela_sistema');
    expect(args[args.indexOf('-i') + 1]).toContain('stream.capture.sink=true');
    expect(args[args.indexOf('-o') + 1]).toContain('node.description=Tela-Sistema-Entrada');
  });

  it('o sink do sistema tem nome, retorno e processo próprios', () => {
    const c = criarSink(null, NOS_DO_SISTEMA);
    expect(c.args.slice(0, 2)).toEqual(['-n', 'tela_sistema_lb']);
    expect(c.args[c.args.indexOf('-i') + 1]).toContain('node.name=tela_sistema node.description=Tela-Sistema ');
    expect(c.args.at(-1)).toBe('node.name=tela_sistema_retorno');
  });

  it('nenhum nome nosso escapa do prefixo que a limpeza reconhece', () => {
    for (const c of [criarSink(null), criarSink(null, NOS_DO_SISTEMA), criarEntradaDoJogo(), criarEntradaDoSistema()]) {
      const nomes = c.args.join(' ').match(/node\.name=(\S+)/g) ?? [];
      expect(nomes.length).toBeGreaterThan(0);
      for (const n of nomes) expect(n).toMatch(/^node\.name=tela_(jogo|sistema)/);
    }
  });
});

describe('moverParaSink / restaurarStream', () => {
  it('move um stream pelo metadado default', () => {
    expect(moverParaSink(97).args).toEqual(['-n', 'default', '97', 'target.object', 'tela_jogo', 'Spa:String']);
    expect(moverParaSink(97, 'tela_sistema').args[4]).toBe('tela_sistema');
  });

  it('restaurar sem alvo anterior apaga a chave', () => {
    expect(restaurarStream(97, null).args).toEqual(['-n', 'default', '-d', '97', 'target.object']);
  });

  it('restaurar com alvo anterior grava de volta o mesmo par', () => {
    expect(restaurarStream(97, { valor: 'fone.x', tipo: 'Spa:String' }).args).toEqual(['-n', 'default', '97', 'target.object', 'fone.x', 'Spa:String']);
    expect(restaurarStream(97, { valor: '55', tipo: 'Spa:Id' }).args.at(-1)).toBe('Spa:Id');
  });

  it('S-14: um valor iniciado em `-` não vira opção do pw-metadata; "Fone USB" passa como UM argumento', () => {
    for (const v of ['-d', '--help', '-n', '-']) {
      expect(() => restaurarStream(5, { valor: v, tipo: 'Spa:String' }), v).toThrow(RangeError);
    }
    expect(restaurarStream(5, { valor: 'Fone USB', tipo: 'Spa:String' }).args).toEqual(['-n', 'default', '5', 'target.object', 'Fone USB', 'Spa:String']);
    expect(restaurarStream(5, { valor: 'alsa_output.usb-Fone_USB-00.analog-stereo', tipo: 'Spa:String' }).args[4]).toBe('alsa_output.usb-Fone_USB-00.analog-stereo');
  });

  it('só aceita ids de nó inteiros', () => {
    for (const ruim of [-1, 1.5, Number.NaN, 2 ** 40]) expect(() => moverParaSink(ruim)).toThrow(RangeError);
  });
});

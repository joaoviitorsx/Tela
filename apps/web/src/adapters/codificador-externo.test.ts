import { describe, expect, it } from 'vitest';
import type { AlvoDoCodificador } from '../core/media/alvo-do-codificador.js';
import { CodificadorExterno, type MensagemDoNativo, type PortaDoNativo } from './codificador-externo.js';
import type { ChunkInjetado } from './injecao-worker.js';

const ALVO: AlvoDoCodificador = { width: 1920, height: 1080, fps: 60, bitrate: 12_000_000, limitadoPelaEstimativa: false, perfil: 'baseline', conteudo: 'motion', camadas: 1, codec: 'h264' };
const TRILHA = {} as MediaStreamTrack;

function montar() {
  let t = 0;
  const ordens: string[] = [];
  const entregues: ChunkInjetado[] = [];
  let capturas = 0;
  let mudancasDeFonte = 0;
  const porta: PortaDoNativo = { postMessage: (m) => ordens.push(m.linha), onmessage: null };
  const cod = new CodificadorExterno(
    porta,
    {
      entregar: (c) => entregues.push(c),
      aoCapturar: () => { capturas += 1; },
      aoMudarFonte: () => { mudancasDeFonte += 1; },
    },
    () => t,
  );
  const chegar = (m: MensagemDoNativo) => porta.onmessage?.({ data: m });
  const quadro = (chave = false, width = 1920, height = 1080) =>
    chegar({ tipo: 'quadro', chave, width, height, dados: new ArrayBuffer(8) });
  return {
    cod, ordens, entregues, chegar, quadro,
    capturas: () => capturas,
    mudancasDeFonte: () => mudancasDeFonte,
    passar: (ms: number) => { t += ms; },
  };
}

describe('CodificadorExterno — o processo nativo como codificador único', () => {
  it('iniciar manda o alvo e pede o IDR de quem entra', async () => {
    const { cod, ordens } = montar();
    await cod.iniciar(TRILHA, ALVO);
    expect(ordens).toEqual(['perfil baseline', 'alvo 1920 1080 60 12000000', 'chave']);
  });

  it('cada quadro move a isca e vai para a injeção com seq próprio e contínuo', async () => {
    const { cod, entregues, quadro, capturas } = montar();
    await cod.iniciar(TRILHA, ALVO);
    quadro(true);
    quadro();
    expect(capturas()).toBe(2);
    expect(entregues.map((c) => [c.seq, c.chave])).toEqual([[0, true], [1, false]]);
  });

  it('quadro descartado pela contrapressão ainda move a isca, sem ir para a injeção', async () => {
    const { cod, entregues, chegar, capturas } = montar();
    await cod.iniciar(TRILHA, ALVO);
    chegar({ tipo: 'captura' });
    chegar({ tipo: 'captura' });
    expect(capturas()).toBe(2);
    expect(entregues).toHaveLength(0);
  });

  it('quadro que chega antes de iniciar é descartado: não há sender para ele', () => {
    const { entregues, quadro, capturas } = montar();
    quadro(true);
    expect(entregues).toHaveLength(0);
    expect(capturas()).toBe(0);
  });

  it('o tamanho da captura vem do `pronto` e avisa o transporte', () => {
    const { cod, chegar, mudancasDeFonte } = montar();
    expect(cod.fonte()).toBeNull();
    chegar({ tipo: 'evento', evento: { evento: 'pronto', fonte: { width: 2560, height: 1440 } } });
    expect(cod.fonte()).toEqual({ width: 2560, height: 1440 });
    expect(mudancasDeFonte()).toBe(1);
  });

  it('não reenvia alvo por oscilação de bitrate abaixo de 5%', async () => {
    const { cod, ordens } = montar();
    await cod.iniciar(TRILHA, ALVO);
    ordens.length = 0;
    cod.configurar({ ...ALVO, bitrate: 12_400_000 });
    expect(ordens).toEqual([]);
    cod.configurar({ ...ALVO, bitrate: 9_000_000 });
    cod.configurar({ ...ALVO, bitrate: 9_000_000, width: 1280, height: 720 });
    expect(ordens).toEqual(['alvo 1920 1080 60 9000000', 'alvo 1280 720 60 9000000']);
  });

  it('pedidos de chave em rajada viram uma ordem só', async () => {
    const { cod, ordens, passar } = montar();
    await cod.iniciar(TRILHA, ALVO);
    ordens.length = 0;
    passar(600);
    cod.pedirChave('pli');
    cod.pedirChave('pli');
    cod.pedirChave('entrada');
    expect(ordens).toEqual(['chave']);
    passar(500);
    cod.pedirChave('pli');
    expect(ordens).toEqual(['chave', 'chave']);
    expect(cod.estatisticas().pedidosDeChave).toEqual({ entrada: 2, pli: 3 });
  });

  it('com plateia, PLI espera 40 ms × senders (2 s a N=50); a entrada continua em 500 ms', async () => {
    const { cod, ordens, passar } = montar();
    await cod.iniciar(TRILHA, ALVO); // IDR da entrada em t=0
    ordens.length = 0;
    passar(600);
    cod.pedirChave('pli', 50);
    expect(ordens).toEqual([]); // 600 ms < 2 s
    passar(1_400);
    cod.pedirChave('pli', 50);
    expect(ordens).toEqual(['chave']); // 2 s: abriu
    passar(600);
    cod.pedirChave('atrasado', 50);
    expect(ordens).toEqual(['chave']); // sender para trás paga a mesma janela
    cod.pedirChave('entrada', 50);
    expect(ordens).toEqual(['chave', 'chave']); // quem entra não paga
    passar(100);
    cod.pedirChave('pli', 5);
    expect(ordens).toEqual(['chave', 'chave']); // 100 ms < 500 ms, mesmo com plateia pequena
    passar(400);
    cod.pedirChave('pli', 5);
    expect(ordens).toEqual(['chave', 'chave', 'chave']);
    expect(cod.estatisticas().pedidosDeChave).toEqual({ entrada: 2, pli: 4, atrasado: 1 });
  });

  it('sem `senders` (quem chama não é o worker) vale o piso de 500 ms', async () => {
    const { cod, ordens, passar } = montar();
    await cod.iniciar(TRILHA, ALVO);
    ordens.length = 0;
    passar(499);
    cod.pedirChave('outro');
    expect(ordens).toEqual([]);
    passar(1);
    cod.pedirChave('outro');
    expect(ordens).toEqual(['chave']);
  });

  it('todo aviso de atraso vira ordem — o helper drena sozinho, e o repetido o devolve à contrapressão', () => {
    const { cod, ordens } = montar();
    cod.definirAtraso(0);
    cod.definirAtraso(3);
    cod.definirAtraso(3);
    cod.definirAtraso(0);
    expect(ordens).toEqual(['atraso 0', 'atraso 3', 'atraso 3', 'atraso 0']);
  });

  it('estatísticas: tamanho do último quadro, fps medido, carga do NVENC e falha visível', async () => {
    const { cod, quadro, chegar, passar } = montar();
    await cod.iniciar(TRILHA, ALVO);
    for (let i = 0; i < 60; i += 1) quadro(i === 0, 1280, 720);
    chegar({ tipo: 'evento', evento: { evento: 'stats', msPorQuadro: 2.5, descartados: 0 } });
    passar(1000);
    const s = cod.estatisticas();
    expect(s).toMatchObject({ width: 1280, height: 720, fps: 60, msPorQuadro: 2.5, hardware: true, sobrecarregado: false, idrs: 1 });
    expect(s.implementacao).toBe('nativo·NVENC');
    chegar({ tipo: 'evento', evento: { evento: 'stats', msPorQuadro: 20, descartados: 0 } });
    chegar({ tipo: 'evento', evento: { evento: 'erro', codigo: 'PIPELINE' } });
    expect(cod.estatisticas()).toMatchObject({ sobrecarregado: true, implementacao: 'nativo·falhou(PIPELINE)' });
  });

  it('parar manda `parar` e deixa de ouvir a porta', async () => {
    const { cod, ordens, quadro, entregues } = montar();
    await cod.iniciar(TRILHA, ALVO);
    cod.parar();
    quadro(true);
    expect(ordens.at(-1)).toBe('parar');
    expect(entregues).toHaveLength(0);
  });

  it('perfil da sala: manda a ordem só quando muda, sem reenviar o alvo', async () => {
    const { cod, ordens } = montar();
    await cod.iniciar({} as MediaStreamTrack, ALVO);
    ordens.length = 0;
    cod.configurar({ ...ALVO, perfil: 'main' });
    cod.configurar({ ...ALVO, perfil: 'main' });
    expect(ordens).toEqual(['perfil main']);
    cod.configurar({ ...ALVO, perfil: 'baseline' });
    expect(ordens).toEqual(['perfil main', 'perfil baseline']);
  });

  it('taxa: CBR é o padrão do helper (nada a mandar); VBR experimental manda e volta', async () => {
    let modo: 'vbr' | 'cbr' = 'cbr';
    const ordens: string[] = [];
    const porta = { postMessage: (m: { linha: string }) => ordens.push(m.linha), onmessage: null };
    const cod = new CodificadorExterno(porta as never, { entregar: () => undefined, aoCapturar: () => undefined, aoMudarFonte: () => undefined }, () => 0, () => modo);
    await cod.iniciar({} as MediaStreamTrack, ALVO);
    expect(ordens.some((o) => o.startsWith('taxa'))).toBe(false);
    modo = 'vbr';
    cod.configurar(ALVO);
    modo = 'cbr';
    cod.configurar(ALVO);
    expect(ordens.filter((o) => o.startsWith('taxa'))).toEqual(['taxa vbr', 'taxa cbr']);
  });
});

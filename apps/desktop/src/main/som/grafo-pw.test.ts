import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  alvoFixado,
  appsComSom,
  entradaPronta,
  idDeAppValido,
  lerGrafo,
  noDoSink,
  residuos,
  saidaAtual,
  saidaPadrao,
  streamsDoApp,
  streamsDoSistema,
} from './grafo-pw.js';
import { ehAppDeVozNoLinux } from './apps-de-voz.js';

/** Dumps reais do `pw-dump` (PipeWire 1.6.9), reduzidos e com os nomes trocados. */
const fixture = (nome: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${nome}`, import.meta.url), 'utf8')) as unknown;

const antes = lerGrafo(fixture('pw-dump-antes.json'));
const depois = lerGrafo(fixture('pw-dump-depois.json'));

describe('lerGrafo', () => {
  it('lê os fixtures e recusa o que não é um dump', () => {
    expect(antes).not.toBeNull();
    expect(depois).not.toBeNull();
    expect(lerGrafo('erro: connection refused')).toBeNull();
    expect(lerGrafo({})).toBeNull();
    expect(lerGrafo([null, 3, 'x', { id: 1 }])?.nos).toEqual([]);
  });

  it('tolera o metadado de saída padrão como texto JSON', () => {
    const g = lerGrafo([
      {
        id: 40,
        type: 'PipeWire:Interface:Metadata',
        props: { 'metadata.name': 'default' },
        metadata: [{ subject: 0, key: 'default.audio.sink', type: 'Spa:String:JSON', value: '{"name":"saida.x"}' }],
      },
    ]);
    expect(g === null ? null : saidaPadrao(g)).toEqual({ nome: 'saida.x', descricao: 'saida.x' });
  });
});

describe('saidaPadrao', () => {
  it('é o sink padrão com a descrição legível', () => {
    expect(saidaPadrao(antes!)).toEqual({
      nome: 'alsa_output.pci-0000_00_1f.3.analog-stereo',
      descricao: 'Controlador de áudio Estéreo analógico',
    });
  });
});

describe('appsComSom', () => {
  it('lista um item por app, quem toca primeiro, e agrupa pelo pid', () => {
    const apps = appsComSom(antes!);
    expect(apps.map((a) => [a.id, a.nome, a.pid])).toEqual([
      ['pid:4343', 'Chamada-Voz', 4343],
      ['pid:4242', 'Jogo-Exemplo', 4242],
    ]);
    // O app só é "tocando" se algum stream estiver `running`: o fixture foi tirado com os dois silenciados.
    expect(apps.every((a) => typeof a.tocando === 'boolean')).toBe(true);
  });

  it('não oferece o retorno do próprio sink nem os processos do Tela', () => {
    const apps = appsComSom(depois!);
    expect(apps.map((a) => a.nome)).not.toContain('tela_jogo_lb');
    expect(apps.find((a) => a.pid === 4343)).toBeDefined();
    expect(appsComSom(depois!, new Set([4343])).map((a) => a.pid)).toEqual([4242]);
  });

  it('agrupa streams do mesmo app e usa nome+binário quando não há pid', () => {
    const nos = ['a', 'b', 'c'].map((n, i) => ({
      id: 10 + i,
      type: 'PipeWire:Interface:Node',
      info: {
        state: i === 1 ? 'running' : 'idle',
        props: { 'node.name': `s${n}`, 'media.class': 'Stream/Output/Audio', 'application.name': i < 2 ? 'Jogo' : 'Outro', 'application.process.binary': i < 2 ? 'jogo' : 'outro' },
      },
    }));
    const apps = appsComSom(lerGrafo(nos)!);
    expect(apps).toHaveLength(2);
    expect(apps[0]).toMatchObject({ id: 'app:Jogo|jogo', tocando: true, streams: [10, 11] });
  });

  it('cai no cliente quando o stream não traz pid nem nome', () => {
    const g = lerGrafo([
      { id: 5, type: 'PipeWire:Interface:Client', info: { props: { 'application.name': 'Wine', 'application.process.id': 77, 'application.process.binary': 'wine' } } },
      { id: 9, type: 'PipeWire:Interface:Node', info: { state: 'running', props: { 'node.name': 'x', 'media.class': 'Stream/Output/Audio', 'client.id': 5 } } },
    ]);
    expect(appsComSom(g!)[0]).toMatchObject({ id: 'pid:77', nome: 'Wine', binario: 'wine' });
  });
});

describe('streamsDoApp / saidaAtual / alvoFixado', () => {
  it('acha os streams do app e para onde tocam', () => {
    const streams = streamsDoApp(antes!, 'pid:4242');
    expect(streams).toHaveLength(1);
    expect(saidaAtual(antes!, streams[0]!)).toBe('alsa_output.pci-0000_00_1f.3.analog-stereo');
    expect(streamsDoApp(antes!, 'pid:1')).toEqual([]);
  });

  it('depois de movido, toca no sink do Tela e o alvo fixado aparece', () => {
    const [s] = streamsDoApp(depois!, 'pid:4242');
    expect(saidaAtual(depois!, s!)).toBe('tela_jogo');
    expect(alvoFixado(depois!, s!)).toEqual({ valor: 'tela_jogo', tipo: 'Spa:String' });
    expect(alvoFixado(antes!, s!)).toBeNull();
  });
});

describe('noDoSink / residuos', () => {
  it('só há sink do Tela no grafo em que ele foi criado', () => {
    expect(noDoSink(antes!)).toBeUndefined();
    expect(noDoSink(depois!)?.descricao).toBe('Tela-Jogo');
  });

  it('reconhece os streams que ainda apontam para o sink', () => {
    expect(residuos(depois!).streamsApontando).toEqual([97]);
    expect(residuos(antes!)).toEqual({ streamsApontando: [] });
  });

  it('S-12: um cliente que se declara pw-loopback com um pid qualquer não vira alvo de sinal', () => {
    // O PoC da revisão: `application.process.binary = pw-loopback`, `application.process.id = 1234`
    // e um nó `tela_jogo`. O resultado não carrega pid algum.
    const g = lerGrafo([
      { id: 1, type: 'PipeWire:Interface:Client', info: { props: { 'application.process.binary': 'pw-loopback', 'application.process.id': 1234 } } },
      { id: 2, type: 'PipeWire:Interface:Node', info: { state: 'running', props: { 'node.name': 'tela_jogo', 'media.class': 'Audio/Sink', 'client.id': 1 } } },
    ]);
    expect(JSON.stringify(residuos(g!))).not.toContain('1234');
    expect(Object.keys(residuos(g!))).toEqual(['streamsApontando']);
  });
});

describe('streamsDoSistema', () => {
  const no = (id: number, props: Record<string, unknown>) => ({ id, type: 'PipeWire:Interface:Node', info: { state: 'running', props } });
  const link = (id: number, saida: number, entrada: number) => ({ id, type: 'PipeWire:Interface:Link', info: { props: { 'link.output.node': saida, 'link.input.node': entrada } } });
  const stream = (id: number, extra: Record<string, unknown>) => no(id, { 'node.name': `s${id}`, 'media.class': 'Stream/Output/Audio', ...extra });
  const g = lerGrafo([
    no(1, { 'node.name': 'fone', 'media.class': 'Audio/Sink' }),
    no(2, { 'node.name': 'hdmi', 'media.class': 'Audio/Sink' }),
    no(3, { 'node.name': 'tela_sistema', 'media.class': 'Audio/Sink' }),
    // O cliente do Discord: o nó da call só diz "WEBRTC VoiceEngine"; o binário vem do cliente.
    { id: 30, type: 'PipeWire:Interface:Client', info: { props: { 'application.name': 'Discord', 'application.process.binary': 'Discord', 'application.process.id': 500 } } },
    stream(10, { 'application.name': 'Jogo', 'application.process.id': 100 }),
    stream(11, { 'application.name': 'WEBRTC VoiceEngine', 'client.id': 30 }),
    stream(12, { 'application.name': 'Música', 'application.process.id': 101 }),
    stream(13, { 'application.name': 'Vídeo na TV', 'application.process.id': 102 }),
    stream(14, { 'application.name': 'Recém-aberto', 'application.process.id': 103 }),
    stream(15, { 'application.name': 'Tela', 'application.process.id': 999 }),
    no(16, { 'node.name': 'tela_sistema_retorno', 'media.class': 'Stream/Output/Audio' }),
    stream(17, { 'application.name': 'Fixado', 'application.process.id': 104 }),
    link(50, 10, 1),
    link(51, 11, 1),
    link(52, 12, 3),
    link(53, 13, 2),
    link(54, 15, 1),
    link(55, 16, 1),
    {
      id: 40,
      type: 'PipeWire:Interface:Metadata',
      props: { 'metadata.name': 'default' },
      metadata: [
        { subject: 0, key: 'default.audio.sink', type: 'Spa:String:JSON', value: { name: 'fone' } },
        { subject: 17, key: 'target.object', type: 'Spa:String', value: 'hdmi' },
      ],
    },
  ])!;

  it('o que toca na padrão, o que já está no nosso sink e o que ainda não ligou; nunca a call, o Tela, nossos nós ou outra saída', () => {
    expect(streamsDoSistema(g, 'tela_sistema', new Set([999]), ehAppDeVozNoLinux)).toEqual([10, 12, 14]);
  });

  it('sem a lista de voz, a call entraria: é o predicado que a deixa de fora', () => {
    expect(streamsDoSistema(g, 'tela_sistema', new Set([999]), () => false)).toContain(11);
  });

  it('resíduos reconhecem também o sink do sistema', () => {
    const r = lerGrafo([
      {
        id: 40,
        type: 'PipeWire:Interface:Metadata',
        props: { 'metadata.name': 'default' },
        metadata: [
          { subject: 7, key: 'target.object', type: 'Spa:String', value: 'tela_sistema' },
          { subject: 8, key: 'target.object', type: 'Spa:String', value: 'fone' },
        ],
      },
    ])!;
    expect(residuos(r).streamsApontando).toEqual([7]);
  });
});

describe('entradaPronta', () => {
  const g = lerGrafo([
    { id: 1, type: 'PipeWire:Interface:Node', info: { state: 'running', props: { 'node.name': 'tela_jogo_mic', 'media.class': 'Audio/Source' } } },
    { id: 2, type: 'PipeWire:Interface:Node', info: { state: 'running', props: { 'node.name': 'tela_jogo_mic_cap', 'media.class': 'Stream/Input/Audio' } } },
    { id: 3, type: 'PipeWire:Interface:Node', info: { state: 'running', props: { 'node.name': 'tela_jogo', 'media.class': 'Audio/Sink' } } },
    { id: 9, type: 'PipeWire:Interface:Link', info: { props: { 'link.output.node': 3, 'link.input.node': 2 } } },
  ])!;

  it('pronta quando a fonte existe e a captura dela está ligada', () => {
    expect(entradaPronta(g, 'tela_jogo_mic', 'tela_jogo_mic_cap')).toBe(true);
  });

  it('não está pronta sem a fonte, sem a captura ou sem o link', () => {
    expect(entradaPronta(g, 'tela_sistema_mic', 'tela_sistema_cap')).toBe(false);
    expect(entradaPronta({ ...g, links: [] }, 'tela_jogo_mic', 'tela_jogo_mic_cap')).toBe(false);
    expect(entradaPronta({ ...g, nos: g.nos.filter((n) => n.id !== 1) }, 'tela_jogo_mic', 'tela_jogo_mic_cap')).toBe(false);
  });
});

describe('idDeAppValido', () => {
  it.each(['pid:1', 'pid:4242', 'app:Jogo|jogo'])('aceita %s', (x) => expect(idDeAppValido(x)).toBe(true));
  it.each(['', 'pid:', 'pid:x', 'pid:12345678901', 'app:', 'app:\0', 5, null, 'janela:1:0'])('recusa %s', (x) => expect(idDeAppValido(x)).toBe(false));
});

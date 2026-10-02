import { describe, expect, it } from 'vitest';
import {
  AQUECIMENTO_MS,
  ArvoreDeRepasse,
  BLOQUEIO_MS,
  ESTABILIZAR_MS,
  K_MAX,
  LIMIAR_DO_REPASSE_BPS,
  PRAZO_DO_FILHO_MS,
  SUBIDA_A_CADA_MS,
} from './arvore-de-repasse.js';
import type { DoAnfitriao } from './protocolo-de-repasse.js';

function montar() {
  let agora = 0;
  const enviadas: Array<{ para: string; msg: DoAnfitriao }> = [];
  const pausas: Array<[string, boolean]> = [];
  const atividade: boolean[] = [];
  let vagasMudaram = 0;
  const arvore = new ArvoreDeRepasse({
    enviar: (msg, para) => enviadas.push({ para, msg }),
    pausarVideo: (id, p) => pausas.push([id, p]),
    agora: () => agora,
    aoMudarVagas: () => (vagasMudaram += 1),
    aoMudarAtividade: (a) => atividade.push(a),
  });
  const entra = (id: string, podeRepassar: boolean, rttMs: number | null) =>
    arvore.receber(id, { repasse: 'estado', versao: 1, podeRepassar, rttMs });
  const passa = (ms: number) => {
    agora += ms;
  };
  return { arvore, enviadas, pausas, atividade, entra, passa, vagas: () => vagasMudaram };
}

const APERTADO = LIMIAR_DO_REPASSE_BPS - 1;

describe('ArvoreDeRepasse — quando liga', () => {
  it('malha folgada não liga ninguém', () => {
    const t = montar();
    for (const id of ['a', 'b', 'c', 'd']) t.entra(id, true, 20);
    t.arvore.definirOrcamento(LIMIAR_DO_REPASSE_BPS * 2);
    t.passa(ESTABILIZAR_MS);
    t.arvore.tique();
    expect(t.enviadas).toEqual([]);
  });

  it('com menos de 3 espectadores a malha sempre basta', () => {
    const t = montar();
    t.entra('a', true, 20);
    t.entra('b', true, 20);
    t.arvore.definirOrcamento(APERTADO);
    t.passa(ESTABILIZAR_MS);
    t.arvore.tique();
    expect(t.enviadas).toEqual([]);
  });

  it('espera o espectador assentar antes de mexer nele', () => {
    const t = montar();
    for (const id of ['a', 'b', 'c']) t.entra(id, true, 20);
    t.arvore.definirOrcamento(APERTADO);
    t.passa(ESTABILIZAR_MS - 1);
    t.arvore.tique();
    expect(t.enviadas).toEqual([]);
  });

  it('a porta cheia também liga, mesmo com orçamento alto', () => {
    const t = montar();
    for (const id of ['a', 'b', 'c']) t.entra(id, true, 20);
    t.arvore.definirOrcamento(LIMIAR_DO_REPASSE_BPS * 3);
    t.arvore.definirPortaCheia(true);
    t.passa(ESTABILIZAR_MS);
    t.arvore.tique();
    expect(t.enviadas.length).toBe(2);
  });

  it('cliente antigo (sem `estado`) nunca é movido nem promovido', () => {
    const t = montar();
    t.arvore.receber('velho', { repasse: 'estado', versao: 0, podeRepassar: true, rttMs: 5 });
    t.arvore.forcar();
    t.passa(ESTABILIZAR_MS);
    t.arvore.tique();
    expect(t.enviadas).toEqual([]);
  });
});

describe('ArvoreDeRepasse — a primeira aresta', () => {
  it('promove o candidato de menor RTT e liga primeiro quem não pode repassar', () => {
    const t = montar();
    t.entra('longe', true, 90);
    t.entra('perto', true, 12);
    t.entra('firefox', false, 40);
    t.arvore.definirOrcamento(APERTADO);
    t.passa(ESTABILIZAR_MS);
    t.arvore.tique();
    expect(t.enviadas).toEqual([
      { para: 'perto', msg: { repasse: 'filho', filho: 'firefox' } },
      { para: 'firefox', msg: { repasse: 'pai', pai: 'perto' } },
    ]);
    expect(t.arvore.paiDe('firefox')).toBe('perto');
    expect(t.arvore.vagas()).toBe(1);
    expect(t.atividade).toEqual([true]);
  });

  it('o vídeo direto só pausa quando o filho confirma a imagem do pai', () => {
    const t = montar();
    t.arvore.forcar();
    t.entra('r', true, 10);
    t.entra('f', false, 30);
    t.passa(ESTABILIZAR_MS);
    t.arvore.tique();
    expect(t.pausas).toEqual([]);
    t.arvore.receber('f', { repasse: 'com-pai' });
    expect(t.pausas).toEqual([['f', true]]);
    expect(t.arvore.pausado('f')).toBe(true);
  });

  it('um filho por tique, no máximo', () => {
    const t = montar();
    t.arvore.forcar();
    t.entra('r', true, 10);
    for (const id of ['f1', 'f2', 'f3']) t.entra(id, false, 30);
    t.passa(ESTABILIZAR_MS);
    t.arvore.tique();
    t.arvore.tique();
    // Uma vaga só (k = 1): o segundo tique não acha pai com vaga nem outro
    // candidato a repassador.
    expect(t.enviadas.filter((e) => e.msg.repasse === 'filho')).toHaveLength(1);
  });

  it('repassador é sempre filho direto do anfitrião: um salto, no máximo', () => {
    const t = montar();
    t.arvore.forcar();
    t.entra('r', true, 10);
    t.entra('f', true, 5);
    t.entra('g', false, 30);
    t.passa(ESTABILIZAR_MS);
    t.arvore.tique();
    // `f` tem o menor RTT e vira o repassador; `g` é o filho.
    expect(t.arvore.paiDe('g')).toBe('f');
    t.passa(1);
    t.arvore.tique();
    // Ninguém liga em `g` (filho nunca repassa), nem `f` vira filho.
    expect(t.arvore.filhosDe('g')).toEqual([]);
    expect(t.arvore.paiDe('f')).toBeNull();
  });
});

describe('ArvoreDeRepasse — falhas', () => {
  function ligado() {
    const t = montar();
    t.arvore.forcar();
    t.entra('r', true, 10);
    t.entra('f', false, 30);
    t.passa(ESTABILIZAR_MS);
    t.arvore.tique();
    t.enviadas.length = 0;
    return t;
  }

  it('sem-pai devolve o filho ao anfitrião e solta a aresta no pai', () => {
    const t = ligado();
    t.arvore.receber('f', { repasse: 'com-pai' });
    t.arvore.receber('f', { repasse: 'sem-pai' });
    expect(t.pausas.at(-1)).toEqual(['f', false]);
    expect(t.enviadas).toEqual([
      { para: 'r', msg: { repasse: 'soltar', filho: 'f' } },
      { para: 'f', msg: { repasse: 'pai', pai: null } },
    ]);
    expect(t.arvore.paiDe('f')).toBeNull();
  });

  it('filho que não confirma no prazo volta direto; duas falhas bloqueiam o repassador', () => {
    const t = ligado();
    t.passa(PRAZO_DO_FILHO_MS);
    t.arvore.tique();
    expect(t.arvore.paiDe('f')).toBeNull();
    // Nunca pausou: nada a despausar.
    expect(t.pausas).toEqual([]);
    // Espera um prazo, religa e falha de novo.
    t.passa(PRAZO_DO_FILHO_MS);
    t.arvore.tique();
    expect(t.arvore.paiDe('f')).toBe('r');
    t.passa(PRAZO_DO_FILHO_MS);
    t.arvore.tique();
    expect(t.arvore.paiDe('f')).toBeNull();
    expect(t.arvore.vagas()).toBe(0);
    t.passa(BLOQUEIO_MS - 1);
    t.arvore.tique();
    expect(t.arvore.paiDe('f')).toBeNull();
    t.passa(1);
    t.arvore.tique();
    expect(t.arvore.paiDe('f')).toBe('r');
  });

  it('o repassador sai: os filhos voltam ao anfitrião sem mensagem para quem saiu', () => {
    const t = ligado();
    t.arvore.receber('f', { repasse: 'com-pai' });
    t.arvore.saiu('r');
    expect(t.pausas.at(-1)).toEqual(['f', false]);
    expect(t.enviadas).toEqual([{ para: 'f', msg: { repasse: 'pai', pai: null } }]);
    expect(t.arvore.vagas()).toBe(0);
    expect(t.atividade.at(-1)).toBe(false);
  });

  it('o filho sai: o pai é avisado', () => {
    const t = ligado();
    t.arvore.saiu('f');
    expect(t.enviadas).toEqual([{ para: 'r', msg: { repasse: 'soltar', filho: 'f' } }]);
    expect(t.arvore.filhosDe('r')).toEqual([]);
  });
});

describe('ArvoreDeRepasse — via', () => {
  it('repassa só entre as pontas de uma aresta', () => {
    const t = montar();
    t.arvore.forcar();
    t.entra('r', true, 10);
    t.entra('f', false, 30);
    t.entra('x', false, 30);
    t.passa(ESTABILIZAR_MS);
    t.arvore.tique();
    const filho = t.arvore.filhosDe('r')[0]!;
    const outro = filho === 'f' ? 'x' : 'f';
    t.enviadas.length = 0;
    t.arvore.receber('r', { repasse: 'via', para: filho, dados: { sdp: 1 } });
    t.arvore.receber(filho, { repasse: 'via', para: 'r', dados: { sdp: 2 } });
    t.arvore.receber(outro, { repasse: 'via', para: 'r', dados: { sdp: 3 } });
    t.arvore.receber('r', { repasse: 'via', para: outro, dados: { sdp: 4 } });
    expect(t.enviadas).toEqual([
      { para: filho, msg: { repasse: 'via', de: 'r', dados: { sdp: 1 } } },
      { para: 'r', msg: { repasse: 'via', de: filho, dados: { sdp: 2 } } },
    ]);
  });
});

describe('ArvoreDeRepasse — vagas pela banda medida', () => {
  function comUmFilho() {
    const t = montar();
    t.arvore.forcar();
    t.arvore.definirOrcamento(4_000_000);
    t.entra('r', true, 10);
    for (const id of ['f1', 'f2', 'f3', 'f4']) t.entra(id, false, 30);
    t.passa(ESTABILIZAR_MS);
    t.arvore.tique();
    t.arvore.receber('f1', { repasse: 'com-pai' });
    return t;
  }
  const relatorio = (filhos: number, piorSaidaBps: number | null, sobrecarregado = false) =>
    ({ repasse: 'relatorio', filhos, piorSaidaBps, sobrecarregado }) as const;

  it('ignora a aresta enquanto ela aquece', () => {
    const t = comUmFilho();
    t.arvore.receber('r', relatorio(1, 100_000));
    expect(t.arvore.filhosDe('r')).toHaveLength(1);
  });

  it('folga ganha vaga, uma a cada intervalo, até K_MAX', () => {
    const t = comUmFilho();
    for (let i = 0; i < K_MAX + 2; i += 1) {
      t.passa(Math.max(AQUECIMENTO_MS, SUBIDA_A_CADA_MS));
      t.arvore.receber('r', relatorio(t.arvore.filhosDe('r').length, 6_000_000));
      t.arvore.tique();
      for (const f of t.arvore.filhosDe('r')) t.arvore.receber(f, { repasse: 'com-pai' });
    }
    expect(t.arvore.vagas()).toBe(K_MAX);
    expect(t.arvore.filhosDe('r')).toHaveLength(K_MAX);
  });

  it('aresta apertada devolve o filho mais novo e não religa no tique seguinte', () => {
    const t = comUmFilho();
    t.passa(AQUECIMENTO_MS);
    t.arvore.receber('r', relatorio(1, 1_000_000));
    expect(t.arvore.filhosDe('r')).toEqual([]);
    expect(t.pausas.at(-1)).toEqual(['f1', false]);
    t.arvore.tique();
    expect(t.arvore.filhosDe('r')).toEqual([]);
  });

  it('as vagas somadas avisam a capacidade', () => {
    const t = comUmFilho();
    expect(t.vagas()).toBe(1);
    t.passa(AQUECIMENTO_MS);
    t.arvore.receber('r', relatorio(1, 6_000_000));
    expect(t.arvore.vagas()).toBe(2);
    expect(t.vagas()).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';
import {
  FilaDeInjecao,
  INTERVALO_MINIMO_DE_CHAVE_POR_SENDER_MS,
  JANELA_DE_CHAVE_POR_SENDER_MS,
  ARRASTO_SUSTENTADO_MS,
  JANELA_MINIMA_DE_CHAVE_MS,
  LIMITE_DE_ARRASTO,
  QUADROS_GUARDADOS,
  SENDER_MORTO_MS,
  janelaDeChaveMs,
} from './fila-de-injecao.js';

function montar() {
  let t = 0;
  const fila = new FilaDeInjecao<string>(() => t);
  let seq = 0;
  const codificar = (chave = false) => fila.chegou({ seq: seq++, chave, dados: `q${seq - 1}` });
  return { fila, codificar, passar: (ms: number) => { t += ms; }, seqAtual: () => seq };
}

describe('FilaDeInjecao — um encode, N envios', () => {
  it('quem entra espera um IDR NA PONTA e pede quadro-chave enquanto espera', () => {
    const { fila, codificar } = montar();
    codificar(true); // IDR 0
    codificar(); // P 1 — o IDR já não está na ponta
    fila.entrou('a');
    expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: true });
    codificar(true); // IDR 2 na ponta
    expect(fila.vaga('a')).toMatchObject({ tipo: 'enviar', quadro: { seq: 2 } });
  });

  it('IDR que não está na ponta não serve: começar nele deixaria o sender preso atrás', () => {
    const { fila, codificar } = montar();
    fila.entrou('a');
    expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: true }); // fila vazia
    codificar(true); // IDR 0
    codificar(); // P 1
    codificar(); // P 2
    expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: true });
    codificar(true); // IDR 3
    codificar(); // P 4: o IDR saiu da ponta antes da vaga
    expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: true });
    codificar(true); // IDR 5
    expect(fila.vaga('a')).toMatchObject({ quadro: { seq: 5, chave: true } });
  });

  it('depois do IDR, segue em ordem sem pular nenhum quadro', () => {
    const { fila, codificar } = montar();
    codificar(true);
    fila.entrou('a');
    expect(fila.vaga('a')).toMatchObject({ quadro: { seq: 0 } });
    codificar();
    codificar();
    expect(fila.vaga('a')).toMatchObject({ quadro: { seq: 1 } });
    expect(fila.vaga('a')).toMatchObject({ quadro: { seq: 2 } });
    // Vaga sem quadro novo: descarta, sem pedir chave.
    expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: false });
  });

  it('cada sender anda no próprio passo, sobre os MESMOS quadros', () => {
    const { fila, codificar } = montar();
    codificar(true);
    fila.entrou('a');
    fila.entrou('b');
    expect(fila.vaga('a')).toMatchObject({ quadro: { seq: 0, dados: 'q0' } });
    codificar();
    expect(fila.vaga('a')).toMatchObject({ quadro: { seq: 1 } });
    expect(fila.vaga('b')).toEqual({ tipo: 'descartar', pedirChave: true }); // IDR 0 já não é a ponta
    codificar(true);
    expect(fila.vaga('b')).toMatchObject({ quadro: { seq: 2, chave: true } });
    expect(fila.vaga('a')).toMatchObject({ quadro: { seq: 2 } });
  });

  it('PLI de um espectador faz SÓ aquele sender esperar o próximo IDR', () => {
    const { fila, codificar } = montar();
    codificar(true);
    fila.entrou('a');
    fila.entrou('b');
    fila.vaga('a');
    fila.vaga('b');
    codificar();
    fila.pediuChave('a');
    expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: true });
    expect(fila.vaga('b')).toMatchObject({ quadro: { seq: 1 } });
  });

  it('o atraso mede o sender vivo mais atrasado — e ignora o morto', () => {
    const { fila, codificar, passar } = montar();
    codificar(true);
    fila.entrou('a');
    fila.entrou('morto');
    fila.vaga('a');
    fila.vaga('morto');
    codificar();
    codificar();
    codificar();
    fila.vaga('a'); // 'a' mandou 1; faltam 2 e 3
    expect(fila.atraso()).toBe(3); // o 'morto' ainda conta: está atrás de 1, 2 e 3
    passar(SENDER_MORTO_MS + 1);
    fila.vaga('a'); // 'a' segue vivo
    expect(fila.atraso()).toBe(1); // o morto saiu da conta; 'a' só deve o 3
  });

  it('sender morto que estava esperando IDR também não trava o atraso', () => {
    const { fila, codificar, passar } = montar();
    codificar(true);
    fila.entrou('a');
    fila.vaga('a');
    codificar();
    fila.pediuChave('a');
    fila.vaga('a'); // esperando chave: não entra na conta
    expect(fila.atraso()).toBe(0);
    passar(SENDER_MORTO_MS + 1);
    for (let i = 0; i < 10; i += 1) codificar();
    expect(fila.atraso()).toBe(0);
  });

  it('sender que ficou atrás do que está guardado volta a esperar IDR', () => {
    const { fila, codificar } = montar();
    codificar(true);
    fila.entrou('a');
    fila.vaga('a');
    for (let i = 0; i < QUADROS_GUARDADOS + 5; i += 1) codificar();
    expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: true });
  });

  it('a borda da janela: o quadro Q−1 atrás ainda serve, o Q atrás não', () => {
    const { fila, codificar } = montar();
    codificar(true); // 0
    fila.entrou('a');
    fila.vaga('a'); // próximo = 1
    for (let i = 0; i < QUADROS_GUARDADOS - 1; i += 1) codificar(); // último = Q−1; guardados 0..Q−1
    expect(fila.vaga('a')).toMatchObject({ quadro: { seq: 1 } }); // próximo = 2
    codificar(); // último = Q; guardados 1..Q — o 2 ainda está
    expect(fila.vaga('a')).toMatchObject({ quadro: { seq: 2 } }); // próximo = 3
    codificar(); // último = Q+1; guardados 2..Q+1
    codificar(); // último = Q+2; guardados 3..Q+2 — o 3 é o mais velho e ainda serve
    expect(fila.vaga('a')).toMatchObject({ quadro: { seq: 3 } }); // próximo = 4
    codificar(); // 4..Q+3
    codificar(); // 5..Q+4: o 4 caiu
    expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: true });
  });

  it('o anel dá muitas voltas sem confundir quadro velho com novo', () => {
    const { fila, codificar } = montar();
    codificar(true);
    fila.entrou('a');
    fila.vaga('a');
    // 20 voltas completas, consumindo toda vaga: nunca descarta, sempre o seq certo.
    for (let q = 1; q <= QUADROS_GUARDADOS * 20; q += 1) {
      codificar(q % 120 === 0);
      expect(fila.vaga('a')).toMatchObject({ tipo: 'enviar', quadro: { seq: q, dados: `q${q}` } });
    }
    // Quem entra agora acha o IDR na ponta mesmo depois das voltas.
    codificar(true);
    fila.entrou('b');
    expect(fila.vaga('b')).toMatchObject({ quadro: { seq: QUADROS_GUARDADOS * 20 + 1, chave: true } });
    expect(fila.vaga('a')).toMatchObject({ quadro: { seq: QUADROS_GUARDADOS * 20 + 1 } });
  });

  it('sender atrasado dentro da janela alcança um quadro por vaga, depois das voltas', () => {
    const { fila, codificar } = montar();
    codificar(true);
    fila.entrou('a');
    fila.vaga('a');
    for (let q = 1; q <= QUADROS_GUARDADOS * 3; q += 1) codificar();
    // Está Q−1 atrás? Não: 3Q atrás, caiu. Mas um sender que consome a cada 2 quadros fica dentro.
    expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: true });
    codificar(true);
    fila.vaga('a'); // IDR na ponta, próximo = 3Q+2
    const base = QUADROS_GUARDADOS * 3 + 2;
    for (let i = 0; i < 100; i += 1) {
      codificar();
      codificar();
      expect(fila.vaga('a')).toMatchObject({ quadro: { seq: base + i } });
    }
    expect(fila.atraso()).toBe(100);
  });

  it('buraco na numeração (invariante quebrada) quebra a cadeia: pede IDR em vez de ficar parado', () => {
    const { fila } = montar();
    fila.chegou({ seq: 0, chave: true, dados: 'q0' });
    fila.entrou('a');
    fila.vaga('a'); // próximo = 1
    fila.chegou({ seq: 2, chave: false, dados: 'q2' }); // o 1 nunca chegou
    expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: true });
    fila.chegou({ seq: 3, chave: true, dados: 'q3' });
    expect(fila.vaga('a')).toMatchObject({ quadro: { seq: 3 } });
  });

  it('sender que saiu não conta mais', () => {
    const { fila, codificar } = montar();
    codificar(true);
    fila.entrou('a');
    fila.vaga('a');
    codificar();
    codificar();
    fila.saiu('a');
    expect(fila.atraso()).toBe(0);
  });

  it('conta os senders com vaga: quem entrou, quem apareceu sem avisar, menos quem saiu', () => {
    const { fila } = montar();
    expect(fila.senders()).toBe(0);
    fila.entrou('a');
    fila.entrou('b');
    fila.vaga('c'); // vaga de sender desconhecido o cadastra
    expect(fila.senders()).toBe(3);
    fila.saiu('b');
    fila.saiu('b');
    expect(fila.senders()).toBe(2);
  });
});

describe('FilaDeInjecao — teto de quadro-chave por sender (tempestade de PLI)', () => {
  const FPS = 60;
  const PASSO_MS = 1000 / FPS;

  /**
   * Simula o pior codificador: todo pedido vira IDR no quadro seguinte (janela
   * global zero). O que sobra de proteção é só o teto por sender.
   */
  function simular(segundos: number, pliPorSegundo: number) {
    const { fila, codificar, passar } = montar();
    fila.entrou('spam');
    fila.entrou('ok');
    let pedidoPendente = true;
    let idrs = 0;
    let descartesDoOk = 0;
    let enviadosAoSpam = 0;
    let ultimoEnvioAoSpam = -1;
    let maiorEsperaDoSpam = 0;
    for (let q = 0; q < segundos * FPS; q += 1) {
      const chave = pedidoPendente;
      pedidoPendente = false;
      if (chave) idrs += 1;
      codificar(chave);
      // O spammer manda PLI a `pliPorSegundo`, espalhados pelos quadros.
      if (q > 0 && Math.floor((q * pliPorSegundo) / FPS) !== Math.floor(((q - 1) * pliPorSegundo) / FPS)) {
        fila.pediuChave('spam');
      }
      for (const id of ['spam', 'ok']) {
        const d = fila.vaga(id);
        if (d.tipo === 'descartar') {
          if (d.pedirChave) pedidoPendente = true;
          if (id === 'ok') descartesDoOk += 1;
        } else if (id === 'spam') {
          enviadosAoSpam += 1;
          if (ultimoEnvioAoSpam >= 0) maiorEsperaDoSpam = Math.max(maiorEsperaDoSpam, q - ultimoEnvioAoSpam);
          ultimoEnvioAoSpam = q;
        }
      }
      passar(PASSO_MS);
    }
    return { idrs, descartesDoOk, enviadosAoSpam, maiorEsperaDoSpam };
  }

  it('um sender com 100 PLI/s força no máximo um IDR por intervalo — e o outro sender nem percebe', () => {
    const r = simular(10, 100);
    // O da entrada (1) mais um por intervalo de 2 s em 10 s.
    expect(r.idrs).toBeLessThanOrEqual(1 + Math.ceil(10_000 / INTERVALO_MINIMO_DE_CHAVE_POR_SENDER_MS));
    expect(r.idrs).toBeGreaterThanOrEqual(4); // e o spammer continua sendo atendido, de tempos em tempos
    expect(r.descartesDoOk).toBe(0); // 'ok' recebeu todos os 600 quadros
  });

  it('sem teto, a mesma tempestade seria 1 IDR por quadro: o teto é o que segura', () => {
    const r = simular(2, 100);
    expect(r.idrs).toBeLessThanOrEqual(3);
    // O spammer recupera: nunca fica mais que um intervalo (mais um quadro) sem receber nada.
    expect(r.maiorEsperaDoSpam).toBeLessThanOrEqual(INTERVALO_MINIMO_DE_CHAVE_POR_SENDER_MS / PASSO_MS + 1);
    expect(r.enviadosAoSpam).toBeGreaterThan(0);
  });

  it('um PLI legítimo e esparso (um a cada 3 s) é atendido sempre', () => {
    const { fila, codificar, passar } = montar();
    fila.entrou('a');
    codificar(true);
    expect(fila.vaga('a')).toMatchObject({ quadro: { seq: 0 } });
    for (let rodada = 0; rodada < 3; rodada += 1) {
      passar(3_000);
      codificar();
      fila.pediuChave('a');
      expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: true });
      codificar(true);
      expect(fila.vaga('a')).toMatchObject({ tipo: 'enviar', quadro: { chave: true } });
    }
  });

  it('o IDR da entrada não gasta o direito: PLI logo depois de entrar ainda é atendido', () => {
    const { fila, codificar, passar } = montar();
    fila.entrou('a');
    codificar(true);
    fila.vaga('a'); // entrada
    passar(100);
    codificar();
    fila.pediuChave('a');
    expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: true });
    codificar(true);
    fila.vaga('a'); // este gastou
    passar(100);
    codificar();
    fila.pediuChave('a');
    expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: false });
    passar(INTERVALO_MINIMO_DE_CHAVE_POR_SENDER_MS);
    codificar();
    expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: true });
  });

  it('quem está de molho ainda aproveita o IDR pedido por outro', () => {
    const { fila, codificar } = montar();
    fila.entrou('a');
    fila.entrou('b');
    codificar(true);
    fila.vaga('a');
    fila.vaga('b');
    codificar();
    fila.pediuChave('a');
    fila.vaga('a');
    codificar(true);
    fila.vaga('a'); // gastou o direito
    fila.vaga('b');
    codificar();
    fila.pediuChave('a');
    expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: false });
    fila.entrou('c'); // entra alguém: o IDR da entrada dele serve ao 'a' também
    expect(fila.vaga('c')).toEqual({ tipo: 'descartar', pedirChave: true });
    codificar(true);
    expect(fila.vaga('a')).toMatchObject({ tipo: 'enviar', quadro: { chave: true } });
    expect(fila.vaga('c')).toMatchObject({ tipo: 'enviar', quadro: { chave: true } });
  });

  it('sender que ficou para trás também respeita o intervalo', () => {
    const { fila, codificar, passar } = montar();
    fila.entrou('a');
    codificar(true);
    fila.vaga('a');
    for (let i = 0; i < QUADROS_GUARDADOS + 5; i += 1) codificar();
    expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: true });
    codificar(true);
    fila.vaga('a');
    for (let i = 0; i < QUADROS_GUARDADOS + 5; i += 1) codificar();
    expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: false });
    passar(INTERVALO_MINIMO_DE_CHAVE_POR_SENDER_MS);
    expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: true });
  });
});

describe('janelaDeChaveMs — coalescência de quadro-chave proporcional à plateia', () => {
  it('com pouca gente é o piso de sempre', () => {
    expect(janelaDeChaveMs(0, 'pli')).toBe(JANELA_MINIMA_DE_CHAVE_MS);
    expect(janelaDeChaveMs(1, 'pli')).toBe(JANELA_MINIMA_DE_CHAVE_MS);
    expect(janelaDeChaveMs(12, 'pli')).toBe(JANELA_MINIMA_DE_CHAVE_MS);
    expect(janelaDeChaveMs(5)).toBe(JANELA_MINIMA_DE_CHAVE_MS);
  });

  it('acima do piso cresce 40 ms por sender: 2 s a N=50', () => {
    expect(janelaDeChaveMs(13, 'pli')).toBe(13 * JANELA_DE_CHAVE_POR_SENDER_MS);
    expect(janelaDeChaveMs(20, 'pli')).toBe(800);
    expect(janelaDeChaveMs(50, 'pli')).toBe(2_000);
    expect(janelaDeChaveMs(50, 'atrasado')).toBe(2_000);
    expect(janelaDeChaveMs(50, 'outro')).toBe(2_000);
    expect(janelaDeChaveMs(50)).toBe(2_000);
  });

  it('quem entra não paga a janela da plateia', () => {
    expect(janelaDeChaveMs(50, 'entrada')).toBe(JANELA_MINIMA_DE_CHAVE_MS);
  });

  it('senders inválidos caem no piso', () => {
    expect(janelaDeChaveMs(-3, 'pli')).toBe(JANELA_MINIMA_DE_CHAVE_MS);
    expect(janelaDeChaveMs(Number.NaN, 'pli')).toBe(JANELA_MINIMA_DE_CHAVE_MS);
  });
});

describe('FilaDeInjecao — tolerância de entrada (repassador, ADR 0031)', () => {
  it('entra num IDR até N quadros atrás da ponta e alcança pelas vagas a mais', () => {
    const fila = new FilaDeInjecao<string>(() => 0, { toleranciaDeEntrada: 2 });
    let seq = 0;
    const chega = (chave = false) => fila.chegou({ seq: seq++, chave, dados: `q${seq - 1}` });
    chega(true); // IDR 0
    chega(); // P 1
    chega(); // P 2 — o IDR está 2 atrás: ainda serve
    fila.entrou('f');
    expect(fila.vaga('f')).toMatchObject({ tipo: 'enviar', quadro: { seq: 0 } });
    expect(fila.vaga('f')).toMatchObject({ tipo: 'enviar', quadro: { seq: 1 } });
    expect(fila.vaga('f')).toMatchObject({ tipo: 'enviar', quadro: { seq: 2 } });
    // Em dia: vaga sem quadro novo não vai ao ar.
    expect(fila.vaga('f')).toEqual({ tipo: 'descartar', pedirChave: false });
  });

  it('além da tolerância, espera o próximo IDR', () => {
    const fila = new FilaDeInjecao<string>(() => 0, { toleranciaDeEntrada: 1 });
    let seq = 0;
    const chega = (chave = false) => fila.chegou({ seq: seq++, chave, dados: `q${seq - 1}` });
    chega(true);
    chega();
    chega();
    fila.entrou('f');
    expect(fila.vaga('f').tipo).toBe('descartar');
    chega(true);
    expect(fila.vaga('f')).toMatchObject({ tipo: 'enviar', quadro: { seq: 3 } });
  });
});

describe('FilaDeInjecao — um espectador lento não segura a sala', () => {
  it('quem fica além do limite POR UM SEGUNDO enquanto outro está em dia é solto e espera IDR', () => {
    const { fila, codificar, passar } = montar();
    fila.entrou('rapido');
    fila.entrou('lento');
    codificar(true);
    expect(fila.vaga('rapido').tipo).toBe('enviar');
    expect(fila.vaga('lento').tipo).toBe('enviar');
    for (let i = 0; i < LIMITE_DE_ARRASTO + 2; i += 1) {
      codificar();
      expect(fila.vaga('rapido').tipo).toBe('enviar'); // o rápido acompanha
    }
    // O lento não teve vaga: está LIMITE+2 atrás e seguraria o codificador.
    expect(fila.atraso()).toBe(LIMITE_DE_ARRASTO + 2);
    // Um instante atrás não basta (rajada do pacer): só sustentado.
    expect(fila.soltarArrastados()).toBe(0);
    passar(ARRASTO_SUSTENTADO_MS - 1);
    fila.vaga('rapido');
    // O lento continua vivo (teve vaga há pouco o bastante para não ser "morto").
    expect(fila.soltarArrastados()).toBe(0);
    passar(1);
    expect(fila.soltarArrastados()).toBe(1);
    expect(fila.atraso()).toBe(0);
    // Solto, ele espera o próximo IDR na ponta.
    expect(fila.vaga('lento')).toEqual({ tipo: 'descartar', pedirChave: true });
    codificar(true);
    expect(fila.vaga('lento')).toMatchObject({ tipo: 'enviar', quadro: { chave: true } });
  });

  it('com um sender só, ninguém é solto: a fila é a dele', () => {
    const { fila, codificar, passar } = montar();
    fila.entrou('unico');
    codificar(true);
    fila.vaga('unico');
    for (let i = 0; i < LIMITE_DE_ARRASTO + 5; i += 1) codificar();
    fila.soltarArrastados();
    passar(ARRASTO_SUSTENTADO_MS);
    expect(fila.soltarArrastados()).toBe(0);
    expect(fila.atraso()).toBe(LIMITE_DE_ARRASTO + 5);
  });

  it('todos atrasados juntos (o codificador é que está rápido): ninguém é solto', () => {
    const { fila, codificar, passar } = montar();
    fila.entrou('a');
    fila.entrou('b');
    codificar(true);
    fila.vaga('a');
    fila.vaga('b');
    for (let i = 0; i < LIMITE_DE_ARRASTO + 3; i += 1) codificar();
    fila.soltarArrastados();
    passar(ARRASTO_SUSTENTADO_MS);
    expect(fila.soltarArrastados()).toBe(0);
  });

  it('quem volta para dentro do limite zera o relógio', () => {
    const { fila, codificar, passar } = montar();
    fila.entrou('a');
    fila.entrou('b');
    codificar(true);
    fila.vaga('a');
    fila.vaga('b');
    for (let i = 0; i < LIMITE_DE_ARRASTO + 2; i += 1) {
      codificar();
      fila.vaga('a');
    }
    fila.soltarArrastados();
    passar(ARRASTO_SUSTENTADO_MS / 2);
    // b alcança.
    while (fila.vaga('b').tipo === 'enviar');
    fila.soltarArrastados();
    passar(ARRASTO_SUSTENTADO_MS / 2 + 1);
    expect(fila.soltarArrastados()).toBe(0);
  });
});

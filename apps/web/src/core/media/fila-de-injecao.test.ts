import { describe, expect, it } from 'vitest';
import { FilaDeInjecao, QUADROS_GUARDADOS, SENDER_MORTO_MS } from './fila-de-injecao.js';

function montar() {
  let t = 0;
  const fila = new FilaDeInjecao<string>(() => t);
  let seq = 0;
  const codificar = (chave = false) => fila.chegou({ seq: seq++, chave, dados: `q${seq - 1}` });
  return { fila, codificar, passar: (ms: number) => { t += ms; } };
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

  it('sender que ficou atrás do que está guardado volta a esperar IDR', () => {
    const { fila, codificar } = montar();
    codificar(true);
    fila.entrou('a');
    fila.vaga('a');
    for (let i = 0; i < QUADROS_GUARDADOS + 5; i += 1) codificar();
    expect(fila.vaga('a')).toEqual({ tipo: 'descartar', pedirChave: true });
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
});

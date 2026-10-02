import { describe, expect, it } from 'vitest';
import { criarPortaoDeParada } from './parada.js';

function relogio() {
  const tarefas: Array<{ fn: () => void; ms: number; viva: boolean }> = [];
  return {
    agendar: (fn: () => void, ms: number) => {
      const t = { fn, ms, viva: true };
      tarefas.push(t);
      return () => {
        t.viva = false;
      };
    },
    estourar: () => tarefas.filter((t) => t.viva).forEach((t) => t.fn()),
    tarefas,
  };
}

describe('portão da parada', () => {
  it('a confirmação resolve true e cancela o prazo', async () => {
    const r = relogio();
    const p = criarPortaoDeParada(r.agendar, 4000);
    const espera = p.aguardar();
    p.confirmar();
    expect(await espera).toBe(true);
    expect(r.tarefas[0]?.viva).toBe(false);
  });
  it('sem confirmação, o prazo resolve false: renderer travado não prende o app', async () => {
    const r = relogio();
    const p = criarPortaoDeParada(r.agendar, 4000);
    const espera = p.aguardar();
    expect(r.tarefas[0]?.ms).toBe(4000);
    r.estourar();
    expect(await espera).toBe(false);
  });
  it('confirmação que chegou antes de alguém esperar vale', async () => {
    const r = relogio();
    const p = criarPortaoDeParada(r.agendar);
    p.confirmar();
    expect(await p.aguardar()).toBe(true);
  });
});

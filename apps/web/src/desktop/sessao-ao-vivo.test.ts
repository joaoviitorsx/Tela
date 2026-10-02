import { describe, expect, it, vi } from 'vitest';
import { criarSessaoAoVivo } from './sessao-ao-vivo.js';
import { estadoVivo, sessaoFalsa } from './testes-de-sessao.js';

describe('sessaoAoVivo', () => {
  it('sem sessão registrada, está ocioso e parar não faz nada', async () => {
    const fonte = criarSessaoAoVivo();
    expect(fonte.instantaneo().state.status).toBe('idle');
    await expect(fonte.parar()).resolves.toBeUndefined();
  });

  it('segue a sessão registrada e marca o instante em que foi ao ar', () => {
    let agora = 1000;
    const fonte = criarSessaoAoVivo(() => agora);
    const a = sessaoFalsa();
    const ouvinte = vi.fn();
    fonte.assinar(ouvinte);
    fonte.registrar(a.sessao);

    a.mudar({ status: 'connecting' });
    expect(fonte.instantaneo().inicioMs).toBeNull();

    agora = 5000;
    a.mudar(estadoVivo());
    expect(fonte.instantaneo().state.status).toBe('live');
    expect(fonte.instantaneo().inicioMs).toBe(5000);

    // O início não anda a cada atualização de estado.
    agora = 9000;
    a.mudar(estadoVivo({ peers: [] }));
    expect(fonte.instantaneo().inicioMs).toBe(5000);
    expect(ouvinte).toHaveBeenCalled();
  });

  it('o instantâneo é estável enquanto nada muda', () => {
    const fonte = criarSessaoAoVivo();
    const a = sessaoFalsa();
    fonte.registrar(a.sessao);
    expect(fonte.instantaneo()).toBe(fonte.instantaneo());
  });

  it('a sessão no ar vence uma ociosa registrada depois (StrictMode cria duas)', () => {
    const fonte = criarSessaoAoVivo();
    const dona = sessaoFalsa();
    const duplicata = sessaoFalsa();
    fonte.registrar(dona.sessao);
    fonte.registrar(duplicata.sessao);
    dona.mudar(estadoVivo());
    expect(fonte.instantaneo().state.status).toBe('live');
  });

  it('parar encerra a sessão no ar com USER_STOPPED', async () => {
    const fonte = criarSessaoAoVivo();
    const a = sessaoFalsa();
    fonte.registrar(a.sessao);
    a.mudar(estadoVivo());
    await fonte.parar();
    expect(a.stop).toHaveBeenCalledWith('USER_STOPPED');
    expect(fonte.instantaneo().state.status).toBe('ended');
    // Sem sessão no ar, não chama `stop` de novo.
    await fonte.parar();
    expect(a.stop).toHaveBeenCalledTimes(1);
  });

  it('ao registrar uma nova, esquece as mortas e solta a assinatura delas', () => {
    const fonte = criarSessaoAoVivo();
    const velha = sessaoFalsa();
    fonte.registrar(velha.sessao);
    velha.mudar({ status: 'ended', reason: 'USER_STOPPED' });
    fonte.registrar(sessaoFalsa().sessao);
    expect(velha.ouvintes.size).toBe(0);
  });

  it('cancelar a assinatura para os avisos', () => {
    const fonte = criarSessaoAoVivo();
    const a = sessaoFalsa();
    fonte.registrar(a.sessao);
    const ouvinte = vi.fn();
    fonte.assinar(ouvinte)();
    a.mudar(estadoVivo());
    expect(ouvinte).not.toHaveBeenCalled();
  });
});

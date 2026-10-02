import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { ipDoCliente, normalizarIp, parseTrustProxy, type ConfiancaNoProxy } from './ip-do-cliente.js';

const nenhuma: ConfiancaNoProxy = { tipo: 'nenhuma' };
const ok = (v: string): ConfiancaNoProxy => {
  const r = parseTrustProxy(v);
  if ('problema' in r) throw new Error(r.problema);
  return r;
};

describe('IP do cliente atrás de proxy (S-17)', () => {
  it('padrão: X-Forwarded-For é IGNORADO — cliente que fala direto não troca de IP', () => {
    expect(ipDoCliente('203.0.113.5', '1.1.1.1, 2.2.2.2', nenhuma)).toBe('203.0.113.5');
    expect(ipDoCliente('203.0.113.5', undefined, nenhuma)).toBe('203.0.113.5');
    expect(ipDoCliente(undefined, '1.1.1.1', nenhuma)).toBe('desconhecido');
  });

  it('1 salto: vale o ÚLTIMO da lista; o que o cliente escreveu à esquerda é descartado', () => {
    // O cliente mandou "9.9.9.9" para se passar por outro; o proxy anexou o IP real dele.
    expect(ipDoCliente('10.0.0.1', '9.9.9.9, 203.0.113.5', ok('1'))).toBe('203.0.113.5');
  });

  it('2 saltos: a segunda entrada da direita', () => {
    expect(ipDoCliente('10.0.0.2', '9.9.9.9, 203.0.113.5, 10.0.0.1', ok('2'))).toBe('203.0.113.5');
  });

  it('cabeçalho com menos entradas que saltos não veio de proxy nosso: usa o socket', () => {
    expect(ipDoCliente('203.0.113.5', '9.9.9.9', ok('2'))).toBe('203.0.113.5');
    expect(ipDoCliente('203.0.113.5', undefined, ok('1'))).toBe('203.0.113.5');
  });

  it('lista de IPs: só lê o cabeçalho se o SOCKET for um dos proxies', () => {
    const confia = ok('10.0.0.1, ::ffff:10.0.0.2');
    expect(ipDoCliente('203.0.113.5', '9.9.9.9', confia)).toBe('203.0.113.5');
    expect(ipDoCliente('10.0.0.1', '9.9.9.9, 203.0.113.5', confia)).toBe('203.0.113.5');
    // Pula proxies encadeados da lista, da direita para a esquerda.
    expect(ipDoCliente('::ffff:10.0.0.2', '203.0.113.5, 10.0.0.1', confia)).toBe('203.0.113.5');
  });

  it('IPv4 mapeado em IPv6 é o mesmo endereço', () => {
    expect(normalizarIp('::FFFF:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizarIp('2001:DB8::1')).toBe('2001:db8::1');
  });

  it('valores inválidos são recusados na configuração', () => {
    expect(parseTrustProxy('')).toEqual({ tipo: 'nenhuma' });
    expect(parseTrustProxy('false')).toEqual({ tipo: 'nenhuma' });
    expect(parseTrustProxy('0')).toEqual({ tipo: 'nenhuma' });
    expect(parseTrustProxy('99')).toHaveProperty('problema');
    expect(parseTrustProxy('true')).toHaveProperty('problema');
    expect(parseTrustProxy('*')).toHaveProperty('problema');
  });

  it('TRUST_PROXY entra pelo config; inválido impede o boot', () => {
    const base = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;
    const bom = parseConfig({ ...base, TRUST_PROXY: '1' });
    expect('config' in bom && bom.config.trustProxy).toEqual({ tipo: 'saltos', n: 1 });
    const padrao = parseConfig(base);
    expect('config' in padrao && padrao.config.trustProxy).toEqual({ tipo: 'nenhuma' });
    expect(parseConfig({ ...base, TRUST_PROXY: 'sim' })).toHaveProperty('problems');
  });

  it('MAX_VIEWERS_PER_IP: 3 em produção, sem freio em dev/e2e (127.0.0.1), configurável', () => {
    const prod = { NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://tela.gg' } as NodeJS.ProcessEnv;
    const emProd = parseConfig(prod);
    expect('config' in emProd && emProd.config.limits.viewersPorIp).toBe(3);
    const dev = parseConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    expect('config' in dev && dev.config.limits.viewersPorIp).toBe(50);
    const explicito = parseConfig({ ...prod, MAX_VIEWERS_PER_IP: '8' });
    expect('config' in explicito && explicito.config.limits.viewersPorIp).toBe(8);
    expect(parseConfig({ ...prod, MAX_VIEWERS_PER_IP: '0' })).toHaveProperty('problems');
  });
});

// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SemCaptura } from './SemCaptura.js';

afterEach(cleanup);

describe('SemCaptura', () => {
  it('diz que transmitir pede um computador e que assistir funciona aqui', () => {
    render(<SemCaptura />);
    expect(screen.getByRole('heading').textContent).toMatch(/USE UM COMPUTADOR/);
    expect(screen.getByRole('status').textContent).toMatch(/Chrome ou no Firefox/);
    expect(screen.getByRole('status').textContent).toMatch(/assistir/);
  });
});

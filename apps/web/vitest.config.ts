import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    // `.tsx` também: a camada React é fina, mas é onde o produto quebrou de
    // verdade, e o padrão anterior (`*.test.ts`) simplesmente não a via.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
});

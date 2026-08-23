import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

/**
 * As fronteiras do AGENTS.md como regra executável.
 *
 * Um comentário dizendo "não importe LiveKit aqui" sobrevive a exatamente um
 * desenvolvedor apressado. Uma regra de lint sobrevive ao projeto inteiro.
 */
/**
 * Bibliotecas de infraestrutura proibidas em domain/, ports/ e application/.
 * Se `apps/api/src/infra/` fosse apagado, essas três camadas ainda compilariam.
 */
const INFRA_LIBS = [
  { name: 'ioredis', message: 'Camada interna não conhece Redis. Use um port.' },
  { name: 'livekit-server-sdk', message: 'Camada interna não conhece LiveKit. Use um port.' },
  { name: 'fastify', message: 'Camada interna não conhece HTTP. Use um port.' },
  { name: '@fastify/websocket', message: 'Camada interna não conhece WebSocket. Use um port.' },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/*.d.ts'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': true, 'ts-expect-error': 'allow-with-description' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  /* ───────────────────── API: as setas apontam para dentro ───────────────────── */
  /**
   * ATENÇÃO ao editar: `no-restricted-imports` NÃO acumula entre blocos — o
   * bloco mais específico SUBSTITUI o anterior inteiro. Por isso o bloco de
   * domain/ repete os `paths` de infraestrutura em vez de só acrescentar
   * `patterns`. Esquecer isso apaga silenciosamente a proteção do bloco de
   * cima, e o lint passa a aprovar `import { Redis } from 'ioredis'` no
   * domínio.
   */
  {
    files: ['apps/api/src/application/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: INFRA_LIBS,
          patterns: [
            {
              group: ['**/infra/**', '**/http/**', '**/composition*'],
              message: 'Camada de dentro não importa camada de fora (AGENTS.md R3).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Só config.ts lê process.env.' },
      ],
    },
  },

  {
    files: ['apps/api/src/domain/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: INFRA_LIBS,
          patterns: [
            {
              group: ['**/ports/**', '**/application/**', '**/infra/**', '**/http/**'],
              message: 'domain/ é puro: não importa nem ports (AGENTS.md R3).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Só config.ts lê process.env.' },
      ],
    },
  },

  {
    files: ['apps/api/src/ports/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: INFRA_LIBS,
          patterns: [
            {
              group: ['**/infra/**', '**/http/**', '**/application/**', '**/composition*'],
              message: 'ports/ declara a interface; não conhece quem a implementa.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['apps/api/src/http/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'ioredis', message: 'http/ não fala com o Redis. Chame um caso de uso.' },
            { name: 'livekit-server-sdk', message: 'http/ não fala com o LiveKit.' },
          ],
        },
      ],
    },
  },

  /* ───────────────────── Web: core/ é portável (R1 e R2) ───────────────────── */
  {
    files: ['apps/web/src/core/**/*.ts', 'apps/web/src/core/**/*.tsx'],
    ignores: ['**/*.test.ts', '**/testing/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react',
              message:
                'core/ vai ser portado para Tauri (Fase 3). Nada de React aqui — AGENTS.md R1.',
            },
            { name: 'react-dom', message: 'core/ não conhece React — AGENTS.md R1.' },
            { name: 'zustand', message: 'core/ não conhece store de UI — AGENTS.md R1.' },
            {
              name: 'livekit-client',
              message: 'core/ fala com MediaTransport, nunca com LiveKit — AGENTS.md R2.',
            },
          ],
          patterns: [
            {
              group: ['**/adapters/**', '**/react/**', '**/components/**', '**/routes/**'],
              message: 'core/ não importa camada de fora.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['apps/web/src/components/**/*.tsx', 'apps/web/src/components/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'livekit-client',
              message: 'Componente é burro: props → JSX. Nada de transporte aqui.',
            },
          ],
          patterns: [
            {
              group: ['**/core/**', '**/adapters/**', '**/container*'],
              message:
                'Componentes recebem dados prontos por props. Zero lógica, zero core/ (AGENTS.md).',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['apps/web/src/react/**/*.ts', 'apps/web/src/routes/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'livekit-client',
              message: 'livekit-client só existe em adapters/ — AGENTS.md R2.',
            },
          ],
          patterns: [
            {
              group: ['**/adapters/**'],
              message: 'Rotas e hooks pegam dependência pronta do container.ts.',
            },
          ],
        },
      ],
    },
  },

  /* Nos testes as fronteiras podem ser atravessadas: é o ponto do teste. */
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/testing/**'],
    rules: { 'no-restricted-imports': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },

  { plugins: { boundaries } },
);

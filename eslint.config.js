import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * As fronteiras do AGENTS.md como regra executável.
 *
 * Um comentário dizendo "não importe X aqui" sobrevive a exatamente um
 * desenvolvedor apressado. Uma regra de lint sobrevive ao projeto inteiro — e
 * a CI planta uma violação de propósito para garantir que a regra ainda morde.
 *
 * ATENÇÃO ao editar: `no-restricted-imports` NÃO acumula entre blocos. O bloco
 * mais específico SUBSTITUI o anterior inteiro, então cada bloco repete o que
 * precisa em vez de só acrescentar. Esquecer isso apaga silenciosamente a
 * proteção do bloco de cima.
 */
const SFU_SDKS = [
  {
    name: 'livekit-client',
    message:
      'R2: nenhum SDK de SFU no projeto. A implementação viva é adapters/mesh-transport.ts.',
  },
  {
    name: 'livekit-server-sdk',
    message: 'R2: nenhum SDK de SFU no projeto.',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/*.d.ts',
      // Documentação da alternativa rejeitada (ADR 0005), não código vivo.
      'apps/web/src/adapters/_reference/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: { parserOptions: { ecmaVersion: 2023, sourceType: 'module' } },
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
      // `throw 'string'` é como o erro esperado escapava do Result (R4).
      '@typescript-eslint/only-throw-error': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  /* ─────────── Web: core/ é portável (R1) e não conhece transporte (R2) ─────────── */
  {
    files: ['apps/web/src/core/**/*.ts', 'apps/web/src/core/**/*.tsx'],
    ignores: ['**/*.test.ts', '**/testing*'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            ...SFU_SDKS,
            {
              name: 'react',
              message:
                'R1: core/ vai ser portado para Tauri (Fase 3). Nada de React aqui.',
            },
            { name: 'react-dom', message: 'R1: core/ não conhece React.' },
            { name: 'zustand', message: 'R1: core/ não conhece store de UI.' },
            { name: 'ws', message: 'R2/R8: core/ fala com SignalingChannel, não com WebSocket.' },
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
          paths: SFU_SDKS,
          patterns: [
            {
              group: ['**/core/**', '**/adapters/**', '**/container*'],
              message: 'Componentes recebem dados prontos por props. Zero lógica, zero core/.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['apps/web/src/react/**/*.ts', 'apps/web/src/routes/**/*.tsx', 'apps/web/src/App.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: SFU_SDKS,
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

  /* ─────────── Signaling: R8, o servidor nunca toca mídia ─────────── */
  {
    files: ['apps/signaling/src/**/*.ts'],
    // `config.ts` é o único que lê env; `server.ts` é o bootstrap, e é dele o
    // ciclo de vida do processo (sinais, exit). Os dois têm licença.
    ignores: [
      '**/*.test.ts',
      '**/testing*',
      'apps/signaling/src/config.ts',
      'apps/signaling/src/server.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', { paths: SFU_SDKS }],
      'no-restricted-globals': [
        'error',
        { name: 'process', message: 'Só config.ts lê process.env.' },
        {
          name: 'RTCPeerConnection',
          message: 'R8: o signaling não toca mídia. Se precisou disto, parou de ser mesh.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[property.name='sdp']",
          message:
            'R8: `payload` é opaco. O servidor não parseia SDP — se ele entender o conteúdo, virou parte do caminho da mídia.',
        },
        {
          selector: "MemberExpression[property.name='candidate']",
          message: 'R8: o servidor não inspeciona ICE.',
        },
      ],
    },
  },

  /* O bootstrap e a config do signaling: sem a proibição de `process`. */
  {
    files: ['apps/signaling/src/config.ts', 'apps/signaling/src/server.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: SFU_SDKS }],
    },
  },

  /* Nos testes as fronteiras podem ser atravessadas: é o ponto do teste. */
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/testing*'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);

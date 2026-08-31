import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
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
    /**
     * As regras de hooks do React, e elas entraram pagando uma dívida.
     *
     * Dois hooks foram declarados DEPOIS de um early return em `Broadcast.tsx`.
     * Enquanto a transmissão não começava o componente registrava N hooks; no
     * instante em que ela começava, N+2. React responde com "Rendered more
     * hooks than during the previous render" e derruba o console — exatamente
     * quando a pessoa aperta TRANSMITIR.
     *
     * Isso foi para produção com lint verde, typecheck verde e 321 testes
     * verdes, porque nenhum deles renderiza a rota nos dois estados. A regra
     * `rules-of-hooks` existe precisamente para esta classe de defeito e pega
     * em tempo de lint, sem renderizar nada.
     *
     * `exhaustive-deps` fica como AVISO e não erro: ele tem falso positivo
     * conhecido com dependências estáveis, e transformar cada um em build
     * vermelho ensina a silenciar a regra — que é como se perde a que importa.
     */
    files: ['apps/web/src/**/*.tsx', 'apps/web/src/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
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

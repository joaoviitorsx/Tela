/**
 * Ciclo de dependência é o modo mais silencioso de uma arquitetura em camadas
 * apodrecer: cada import isolado parece razoável e o grafo vira sopa.
 */
module.exports = {
  forbidden: [
    {
      name: 'sem-ciclos',
      severity: 'error',
      comment: 'Dependência circular entre módulos.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'sem-orfaos',
      severity: 'warn',
      comment: 'Módulo que ninguém importa — provavelmente código morto.',
      from: {
        orphan: true,
        pathNot: [
          '\\.(config|d)\\.ts$',
          'apps/signaling/src/server\\.ts$',
          'apps/web/src/main\\.tsx$',
          'packages/shared/src/index\\.ts$',
          '_reference/',
          '\\.test\\.ts$',
        ],
      },
      to: {},
    },
    {
      name: 'web-core-portavel',
      severity: 'error',
      comment: 'R1/R2: core/ não pode alcançar adapters/, react/ nem components/.',
      from: { path: 'apps/web/src/core/', pathNot: 'testing' },
      to: { path: 'apps/web/src/(adapters|react|components|routes)/' },
    },
    {
      name: 'signaling-nao-toca-web',
      severity: 'error',
      comment: 'R8: o servidor de sinalização não compartilha código de mídia com o cliente.',
      from: { path: 'apps/signaling/' },
      to: { path: 'apps/web/' },
    },
    {
      name: 'sem-dev-dep-em-producao',
      severity: 'error',
      from: { path: 'apps/(signaling|web)/src', pathNot: '\\.test\\.ts$|testing' },
      to: { dependencyTypes: ['npm-dev'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    exclude: { path: 'node_modules|dist|_reference' },
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    },
  },
};

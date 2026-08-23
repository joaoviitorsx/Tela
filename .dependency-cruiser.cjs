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
          'apps/api/src/server\\.ts$',
          'apps/web/src/main\\.tsx$',
          'packages/shared/src/index\\.ts$',
          '\\.test\\.ts$',
        ],
      },
      to: {},
    },
    {
      name: 'api-domain-puro',
      severity: 'error',
      comment: 'domain/ e application/ não podem alcançar infra/ nem http/.',
      from: { path: 'apps/api/src/(domain|application)/' },
      to: { path: 'apps/api/src/(infra|http)/' },
    },
    {
      name: 'web-core-portavel',
      severity: 'error',
      comment: 'core/ do web não pode alcançar adapters/, react/ nem components/.',
      from: { path: 'apps/web/src/core/', pathNot: 'testing/' },
      to: { path: 'apps/web/src/(adapters|react|components|routes)/' },
    },
    {
      name: 'sem-dev-dep-em-producao',
      severity: 'error',
      from: { path: 'apps/(api|web)/src', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['npm-dev'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    exclude: { path: 'node_modules|dist' },
    // O código usa extensão `.js` em import de `.ts` (exigência do NodeNext).
    // Sem estas duas opções o cruiser não resolve nada e reporta tudo como
    // órfão — um falso verde perfeito.
    enhancedResolveOptions: {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    },
  },
};

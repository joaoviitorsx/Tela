import { loadConfig } from './config.js';
import { compose } from './composition.js';
import { buildApp } from './http/app.js';

const config = loadConfig();
const deps = compose(config);
const app = await buildApp(config, deps);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'encerrando');
  await app.close();
  await deps.shutdown();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
app.log.info(
  { transport: config.TELA_TRANSPORT, store: config.store, maxViewers: config.MAX_VIEWERS },
  'tela api no ar',
);

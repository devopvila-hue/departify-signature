/**
 * Entry point of the local signature server.
 *
 * Starts the API and, when a production build of the web client exists, serves
 * it from the same origin so the whole application runs on a single port.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import FastifyStatic from '@fastify/static';
import { Store } from './store.js';
import { SignatureService } from './service.js';
import { buildServer } from './routes.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(packageRoot, '../..');

const PORT = Number(process.env.PORT ?? 4310);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATA_DIR = process.env.SIGNATUREIT_DATA_DIR ?? join(packageRoot, 'data');
const WEB_DIST = join(repoRoot, 'apps/web/dist');

async function main(): Promise<void> {
  const store = new Store(join(DATA_DIR, 'signatureit.db'));
  const service = new SignatureService(store, DATA_DIR);
  const app = await buildServer({ store, service, logger: process.env.LOG_LEVEL !== 'silent' });

  if (existsSync(join(WEB_DIST, 'index.html'))) {
    await app.register(FastifyStatic, { root: WEB_DIST, prefix: '/' });
    // SPA fallback: any non-API path renders the client router.
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.status(404).send({ error: 'not_found', message: 'Route not found.' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler(async (request, reply) =>
      reply.status(404).send({
        error: 'not_found',
        message: 'Route not found. Run `pnpm build` to serve the web client from this server.',
      }),
    );
  }

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`DEPARTIFY Signature API listening on http://${HOST}:${PORT}`);
  app.log.info(`Data directory: ${DATA_DIR}`);

  const shutdown = async () => {
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

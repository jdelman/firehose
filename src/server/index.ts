import { ChannelRegistry } from './channel-registry.ts';
import { logHttpRequest } from './logger.ts';
import { InMemoryPubSubAdapter } from './pubsub/in-memory-pubsub.ts';
import { routeRequest } from './routes.ts';
import { BlueskyFirehoseSource } from './sources/bluesky-firehose.ts';
import type { PostSourceAdapter } from './sources/source.ts';
import { XStreamManager } from './sources/x-stream.ts';

export function startServer(port = Number(process.env.PORT ?? 3000)) {
  const xStream = new XStreamManager();
  const registry = new ChannelRegistry({
    pubsub: new InMemoryPubSubAdapter(),
    createSource: ({ sources, ...config }) => {
      const adapters: PostSourceAdapter[] = sources.map(source => source === 'x'
        ? xStream.source(config) : new BlueskyFirehoseSource(config));
      return {
        getBlueskyConnectionCount() { return adapters.reduce((total, adapter) => total + (adapter.getBlueskyConnectionCount?.() ?? 0), 0); },
        start() { for (const adapter of adapters) adapter.start(); },
        async stop() { await Promise.all(adapters.map(adapter => adapter.stop())); },
      };
    },
  });

  const server = Bun.serve({
    hostname: '0.0.0.0',
    port,
    async fetch(request, server) {
      const response = await routeRequest(request, registry);
      const url = new URL(request.url);
      const requestIp = server.requestIP(request)?.address ?? '-';
      const bytes = response.headers.get('Content-Length') ?? '-';

      logHttpRequest({
        ip: requestIp,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        status: response.status,
        bytes,
        referer: request.headers.get('referer'),
        userAgent: request.headers.get('user-agent'),
      });

      return response;
    },
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.stop(true);
    await xStream.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return server;
}

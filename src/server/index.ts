import { ChannelRegistry } from './channel-registry.ts';
import { logHttpRequest } from './logger.ts';
import { InMemoryPubSubAdapter } from './pubsub/in-memory-pubsub.ts';
import { routeRequest } from './routes.ts';
import { BlueskyFirehoseSource } from './sources/bluesky-firehose.ts';

export function startServer(port = Number(process.env.PORT ?? 3000)) {
  const registry = new ChannelRegistry({
    pubsub: new InMemoryPubSubAdapter(),
    createSource: ({ channelKey, filterTexts, callbacks }) =>
      new BlueskyFirehoseSource({
        channelKey,
        filterTexts,
        callbacks,
      }),
  });

  const server = Bun.serve({
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

  return server;
}

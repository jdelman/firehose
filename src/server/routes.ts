import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';

import type { ChannelRegistry } from './channel-registry.ts';
import { serializeSseEvent } from './models/events.ts';

const textEncoder = new TextEncoder();
const webRoot = join(import.meta.dir, '../web');
const transpiler = new Bun.Transpiler({
  loader: 'ts',
  target: 'browser',
});

export async function routeRequest(request: Request, registry: ChannelRegistry): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/') {
    return serveStaticFile('index.html', 'text/html; charset=utf-8');
  }

  if (url.pathname === '/web/styles.css') {
    return serveStaticFile('styles.css', 'text/css; charset=utf-8');
  }

  if (url.pathname.startsWith('/web/') && url.pathname.endsWith('.js')) {
    return serveBrowserModule(url.pathname);
  }

  if (url.pathname === '/events') {
    return createSseResponse(request, registry, url.searchParams.getAll('filter'));
  }

  if (url.pathname === '/reset-bigrams' && request.method === 'POST') {
    registry.resetBigrams(url.searchParams.getAll('filter'));
    return new Response(null, {
      status: 204,
    });
  }

  return new Response('Not found', {
    status: 404,
  });
}

async function serveStaticFile(relativePath: string, contentType: string): Promise<Response> {
  const filePath = resolveWebPath(relativePath);
  const file = Bun.file(filePath);

  return new Response(file, {
    headers: {
      'Content-Type': contentType,
    },
  });
}

async function serveBrowserModule(pathname: string): Promise<Response> {
  const relativePath = pathname.replace('/web/', '').replace(/\.js$/, '.ts');
  const filePath = resolveWebPath(relativePath);
  const source = await readFile(filePath, 'utf8');
  const output = transpiler.transformSync(source);

  return new Response(output, {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
    },
  });
}

function resolveWebPath(relativePath: string): string {
  const safePath = normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
  return join(webRoot, safePath);
}

function createSseResponse(
  request: Request,
  registry: ChannelRegistry,
  filterTexts: string[],
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const send = (chunk: string) => {
        controller.enqueue(textEncoder.encode(chunk));
      };

      const subscription = registry.subscribe({
        filterTexts,
        listener: (event) => {
          send(serializeSseEvent(event));
        },
      });

      send(
        serializeSseEvent({
          type: 'summary',
          data: subscription.snapshot.summary,
        }),
      );
      send(
        serializeSseEvent({
          type: 'bigrams',
          data: subscription.snapshot.bigrams,
        }),
      );
      send(
        serializeSseEvent({
          type: 'system',
          data: {
            message: subscription.channelKey,
          },
        }),
      );

      const cleanup = () => {
        void subscription.unsubscribe();
        controller.close();
      };

      request.signal.addEventListener('abort', cleanup, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  });
}

import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';

import type { ChannelRegistry } from './channel-registry.ts';
import { serializeSseEvent } from './models/events.ts';
import { normalizeSources, type SourceName } from './sources/source.ts';
import { checkSitePassword } from './site-auth.ts';
import { adminUsage } from './admin-usage.ts';

const textEncoder = new TextEncoder();
const webRoot = join(import.meta.dir, '../web');
const transpiler = new Bun.Transpiler({
  loader: 'ts',
  target: 'browser',
});

export async function routeRequest(request: Request, registry: ChannelRegistry): Promise<Response> {
  const authResponse = await checkSitePassword(request);
  if (authResponse) return authResponse;
  const url = new URL(request.url);
  if (url.pathname === '/admin' || url.pathname === '/admin/usage') {
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
    if (url.pathname === '/admin') return serveStaticFile('admin.html', 'text/html; charset=utf-8');
    return Response.json(await adminUsage.getUsage(), { headers: { 'Cache-Control': 'no-store' } });
  }
  const xEnabled = process.env.ENABLE_X?.trim().toLowerCase() === 'true';
  const sources = normalizeSources(url.searchParams.has('source') ? url.searchParams.getAll('source') : undefined)
    .filter(source => source !== 'x' || xEnabled);

  if (url.pathname === '/') {
    const html = await Bun.file(join(webRoot, 'index.html')).text();
    return new Response(html.replace('data-enable-x="false"', `data-enable-x="${xEnabled}"`), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  if (url.pathname === '/sounds/gunshot.m4a') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const file = Bun.file(join(import.meta.dir, '../../sounds/gunshot.m4a'));
    return new Response(request.method === 'HEAD' ? null : file, {
      headers: { 'Content-Type': 'audio/mp4', 'Content-Length': String(file.size), 'Cache-Control': 'public, max-age=3600' },
    });
  }

  if (url.pathname === '/web/styles.css') {
    return serveStaticFile('styles.css', 'text/css; charset=utf-8');
  }

  if (url.pathname.startsWith('/web/') && url.pathname.endsWith('.js')) {
    return serveBrowserModule(url.pathname);
  }

  if (url.pathname === '/events') {
    if (!sources.length) return new Response(xEnabled ? 'Select Bluesky or X.' : 'X is disabled. Select Bluesky.', { status: 400 });
    return createSseResponse(request, registry, url.searchParams.getAll('filter'), sources);
  }

  if (url.pathname === '/reset-bigrams' && request.method === 'POST') {
    registry.resetBigrams(url.searchParams.getAll('filter'), sources);
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
      'Cache-Control': 'no-store',
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
  sources: SourceName[],
): Response {
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const send = (chunk: string) => {
        controller.enqueue(textEncoder.encode(chunk));
      };

      const subscription = registry.subscribe({
        sources,
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

      let closed = false;
      for (const message of subscription.snapshot.systemMessages) {
        send(serializeSseEvent({ type: 'system', data: { message } }));
      }
      cleanup = () => {
        if (closed) return;
        closed = true;
        request.signal.removeEventListener('abort', cleanup);
        void subscription.unsubscribe();
        try { controller.close(); } catch { /* Already canceled by the browser. */ }
      };

      request.signal.addEventListener('abort', cleanup, { once: true });
      if (request.signal.aborted) cleanup();
    },
    cancel() { cleanup(); },
  });

  return new Response(stream, {
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  });
}

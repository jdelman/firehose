import { describe, expect, test } from 'bun:test';
import cbor from 'cbor';
import { WebSocketServer, type WebSocket } from 'ws';
import { BlueskyFirehoseSource } from '../src/server/sources/bluesky-firehose.ts';
import type { AuthorUpdate, GenericPost } from '../src/server/models/post.ts';

async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for firehose state');
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    const byte = value & 0x7f;
    value >>>= 7;
    bytes.push(byte | (value ? 0x80 : 0));
  } while (value);
  return Buffer.from(bytes);
}

async function frame(did: string, text = 'hello', langs = ['en'], embed?: unknown): Promise<Buffer> {
  const record = await cbor.encodeAsync({ $type: 'app.bsky.feed.post', text, langs, createdAt: new Date().toISOString(), ...(embed ? { embed } : {}) });
  const cid = Buffer.concat([Buffer.from([18, 32]), Buffer.alloc(32)]);
  const header = await cbor.encodeAsync({ version: 1, roots: [] });
  const blocks = Buffer.concat([varint(header.length), header, varint(cid.length + record.length), cid, record]);
  return Buffer.concat([
    await cbor.encodeAsync({ op: 1, t: '#commit' }),
    await cbor.encodeAsync({ repo: did, blocks, ops: [{ action: 'create', path: 'app.bsky.feed.post/test' }] }),
  ]);
}

async function fixture(fetcher: typeof fetch = (async () => Response.json({})) as typeof fetch, filters: string[] = []) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const connections: WebSocket[] = [];
  server.on('connection', socket => connections.push(socket));
  const address = server.address() as { port: number };
  const posts: GenericPost[] = [];
  const messages: string[] = [];
  const authors: AuthorUpdate[] = [];
  const source = new BlueskyFirehoseSource({
    channelKey: 'test', filterTexts: filters, endpoint: `ws://127.0.0.1:${address.port}`, fetcher,
    callbacks: { onPost: post => posts.push(post), onAuthor: author => authors.push(author), onSystemMessage: message => messages.push(message) },
  });
  return {
    source, posts, messages, authors, connections,
    async close() {
      source.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

describe('Bluesky firehose recovery and delivery', () => {
  test('delivers images from binary firehose CIDs, quote-with-media embeds, and JSON blob references', async () => {
    const f = await fixture();
    const did = 'did:plc:image-fixture';
    const cid = 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const binaryRef = () => new cbor.Tagged(42, Buffer.from([0, 1, 85, 18, 32, ...new Uint8Array(32)]));
    const imageEmbed = (image: unknown) => ({
      $type: 'app.bsky.embed.images', images: [{ alt: 'A cat wearing a hat', image }],
    });
    const embeds = [
      imageEmbed({ $type: 'blob', ref: binaryRef(), mimeType: 'image/jpeg', size: 123 }),
      { $type: 'app.bsky.embed.recordWithMedia', media: imageEmbed({ ref: binaryRef() }) },
      imageEmbed({ ref: { $link: cid } }),
      imageEmbed({ cid, mimeType: 'image/jpeg' }),
      imageEmbed({ ref: new cbor.Tagged(42, Buffer.from([0, 255])) }),
      imageEmbed({ ref: new cbor.Tagged(42, Buffer.from([1, 1, 85, 18, 32, ...new Uint8Array(32)])) }),
    ];
    try {
      f.source.start();
      await until(() => f.connections.length === 1);
      for (let index = 0; index < embeds.length; index++) {
        f.connections[0]!.send(await frame(did, `photo ${index}`, ['en'], embeds[index]));
      }
      await until(() => f.posts.length === embeds.length);
      for (const post of f.posts.slice(0, 4)) {
        expect(post.images).toEqual([{
          url: `https://cdn.bsky.app/img/feed_fullsize/plain/did%3Aplc%3Aimage-fixture/${cid}@jpeg`,
          alt: 'A cat wearing a hat',
        }]);
      }
      expect(f.posts[4]!.images).toBeUndefined();
      expect(f.posts[5]!.images).toBeUndefined();
      expect(f.messages.some(message => message.startsWith('Firehose message error'))).toBe(false);
    } finally { await f.close(); }
  });

  test('reconnects after an abnormal close and resumes delivering posts', async () => {
    const f = await fixture();
    try {
      f.source.start();
      f.source.start(); // Starting twice must not create parallel subscriptions.
      await until(() => f.connections.length === 1);
      f.connections[0]!.send(await frame('did:plc:before'));
      await until(() => f.posts.length === 1);
      f.connections[0]!.terminate();
      await until(() => f.connections.length === 2);
      f.connections[1]!.send(await frame('did:plc:after'));
      await until(() => f.posts.length === 2);
      expect(f.messages.some(message => message.includes('1006') && message.includes('Reconnecting'))).toBe(true);
      expect(f.messages.filter(message => message.startsWith('Connected'))).toHaveLength(2);
      expect(f.posts[1]?.authorId).toBe('did:plc:after');
    } finally { await f.close(); }
  });

  test('stop cancels a pending reconnect and start can open a fresh connection', async () => {
    const f = await fixture();
    try {
      f.source.start();
      await until(() => f.connections.length === 1);
      f.connections[0]!.terminate();
      await until(() => f.messages.some(message => message.includes('Reconnecting')));
      f.source.stop();
      await Bun.sleep(1_100);
      expect(f.connections).toHaveLength(1);
      f.source.start();
      await until(() => f.connections.length === 2);
      f.source.stop();
      await Bun.sleep(1_100);
      expect(f.connections).toHaveLength(2);
    } finally { await f.close(); }
  });

  test('waits one second on cache misses, sends without a name, and updates it later', async () => {
    let finish!: (response: Response) => void;
    let lookups = 0;
    const fetcher = (async () => {
      lookups++;
      return new Promise<Response>(resolve => { finish = resolve; });
    }) as typeof fetch;
    const f = await fixture(fetcher, ['hello']);
    try {
      f.source.start();
      await until(() => f.connections.length === 1);
      const socket = f.connections[0]!;
      socket.send(await frame('did:plc:excluded', 'unrelated'));
      socket.send(await frame('did:plc:other-language', 'hello', ['es']));
      socket.send(await frame('did:plc:slow'));
      socket.send(await frame('did:plc:slow', 'hello again'));
      await until(() => lookups === 1);
      await Bun.sleep(200);
      expect(f.posts).toHaveLength(0);
      await until(() => f.posts.length === 2);
      expect(lookups).toBe(1);
      expect(f.posts[0]?.username).toBeUndefined();
      expect(JSON.stringify(f.posts[0])).not.toContain('"username"');
      expect(f.posts[0]?.profileUrl).toBe('https://bsky.app/profile/did:plc:slow');
      expect(f.posts[0]?.postUrl).toBe('https://bsky.app/profile/did:plc:slow/post/test');
      expect(f.authors).toHaveLength(0);
      finish(Response.json({ handle: 'tester.bsky.social' }));
      await until(() => f.authors.length === 1);
      expect(f.authors).toEqual([{ source: 'bluesky', authorId: 'did:plc:slow', username: 'tester.bsky.social' }]);
      expect(f.posts).toHaveLength(2); // Existing posts receive a name update without another post arriving.
      const cachedStart = performance.now();
      socket.send(await frame('did:plc:slow', 'hello with handle'));
      await until(() => f.posts.length === 3);
      expect(performance.now() - cachedStart).toBeLessThan(500);
      expect(f.posts[2]?.username).toBe('tester.bsky.social');
      expect(lookups).toBe(1);
    } finally { await f.close(); }
  });

  test('includes a handle resolved during the one-second wait', async () => {
    let finish!: (response: Response) => void;
    let lookupStarted = false;
    const f = await fixture((async () => {
      lookupStarted = true;
      return new Promise<Response>(resolve => { finish = resolve; });
    }) as typeof fetch);
    try {
      f.source.start();
      await until(() => f.connections.length === 1);
      f.connections[0]!.send(await frame('did:plc:quick-lookup'));
      await until(() => lookupStarted);
      finish(Response.json({ handle: 'quick.bsky.social' }));
      await Bun.sleep(200);
      expect(f.posts).toHaveLength(0);
      await until(() => f.posts.length === 1);
      expect(f.posts[0]?.username).toBe('quick.bsky.social');
      expect(f.authors).toHaveLength(0);
    } finally { await f.close(); }
  });

  test('pausing discards posts pending the one-second username check', async () => {
    let lookupStarted = false;
    const f = await fixture((async () => {
      lookupStarted = true;
      return Response.json({ handle: 'paused.bsky.social' });
    }) as typeof fetch);
    try {
      f.source.start();
      await until(() => f.connections.length === 1);
      f.connections[0]!.send(await frame('did:plc:pending-at-stop'));
      await until(() => lookupStarted);
      f.source.stop();
      await Bun.sleep(1_100);
      expect(f.posts).toHaveLength(0);
      expect(f.authors).toHaveLength(0);
    } finally { await f.close(); }
  });

  test('failed profile lookups and malformed frames do not stop delivery', async () => {
    const f = await fixture((async () => { throw new Error('lookup unavailable'); }) as typeof fetch);
    try {
      f.source.start();
      await until(() => f.connections.length === 1);
      f.connections[0]!.send(Buffer.from([0xff]));
      f.connections[0]!.send(await frame('did:plc:failed-lookup'));
      await until(() => f.posts.length === 1);
      expect(f.posts[0]?.username).toBeUndefined();
      expect(f.authors).toHaveLength(0);
      expect(f.messages.some(message => message.startsWith('Firehose message error'))).toBe(true);
    } finally { await f.close(); }
  });
});

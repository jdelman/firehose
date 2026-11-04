import cbor from 'cbor';
import { CID } from 'multiformats/cid';
import { base32 } from 'multiformats/bases/base32';
import WebSocket from 'ws';

import { logBlueskyEvent } from '../logger.ts';
import type { GenericPost, PostFacet, PostImage } from '../models/post.ts';
import { normalizeFilter, normalizeFilters } from '../models/post.ts';
import type { PostSourceAdapter, SourceCallbacks } from './source.ts';

const { decodeAllSync, decodeFirstSync } = cbor;

const DEFAULT_ENDPOINT =
  process.env.BLUESKY_FIREHOSE_URL ??
  'wss://bsky.network/xrpc/com.atproto.sync.subscribeRepos';
const DEFAULT_LANGUAGE = 'en';
const POST_RECORD_TYPE = 'app.bsky.feed.post';

type HandleEntry = { handle: string; resolved: Promise<string> };
const handleCache = new Map<string, HandleEntry>();
const MAX_CACHED_HANDLES = 10_000;
const USERNAME_WAIT_MS = 1_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const STABLE_CONNECTION_MS = 30_000;

type CommitFrame = {
  repo?: string;
  blocks?: Uint8Array;
  time?: string;
  ops?: Array<{
    action?: string;
    path?: string;
  }>;
};

export class BlueskyFirehoseSource implements PostSourceAdapter {
  private readonly channelKey: string;
  private readonly filterTexts: string[];
  private readonly rawFilterTexts: string[];
  private readonly callbacks: SourceCallbacks;
  private readonly endpoint: string;
  private socket: WebSocket | null = null;
  private disconnectLogged = false;
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private readonly fetcher: typeof fetch;
  private readonly pendingHandles = new Set<string>();
  private readonly pendingPosts = new Set<ReturnType<typeof setTimeout>>();

  constructor(config: {
    channelKey: string;
    filterTexts: string[];
    callbacks: SourceCallbacks;
    endpoint?: string;
    fetcher?: typeof fetch;
  }) {
    this.channelKey = config.channelKey;
    this.filterTexts = normalizeFilters(config.filterTexts);
    this.rawFilterTexts = config.filterTexts;
    this.callbacks = config.callbacks;
    this.endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    this.fetcher = config.fetcher ?? fetch;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    this.disconnectLogged = false;
    const socket = new WebSocket(this.endpoint, {
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
    });
    this.socket = socket;
    let openedAt = 0;

    socket.on('open', () => {
      if (this.stopped || this.socket !== socket) return;
      openedAt = Date.now();
      logBlueskyEvent({
        event: 'CONNECT',
        filterText: this.rawFilterTexts.join(', ') || '__all__',
        endpoint: this.endpoint,
      });
      this.callbacks.onSystemMessage(`Connected to ${this.endpoint}`);
    });

    socket.on('message', (data) => {
      if (this.stopped || this.socket !== socket) return;
      try {
        this.handleMessage(data);
      } catch (error) {
        this.callbacks.onSystemMessage(`Firehose message error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    socket.on('error', (error) => {
      if (this.stopped || this.socket !== socket) return;
      this.callbacks.onSystemMessage(`Firehose error: ${error.message}`);
    });

    socket.on('close', (code, reason) => {
      if (this.stopped || this.socket !== socket) return;
      this.socket = null;
      if (!this.disconnectLogged) {
        this.disconnectLogged = true;
        const detail = reason ? `code=${code} reason=${reason.toString()}` : `code=${code}`;
        logBlueskyEvent({
          event: 'DISCONNECT',
          filterText: this.rawFilterTexts.join(', ') || '__all__',
          endpoint: this.endpoint,
          detail,
        });
      }

      const detail = reason ? ` (${reason.toString()})` : '';
      if (openedAt && Date.now() - openedAt >= STABLE_CONNECTION_MS) {
        this.reconnectAttempt = 0;
      }
      const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempt);
      this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 5);
      const delay = Math.round(ceiling * (0.5 + Math.random() * 0.5));
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
      this.reconnectTimer.unref?.();
      this.callbacks.onSystemMessage(
        `Firehose closed with code ${code}${detail}. Reconnecting in ${(delay / 1_000).toFixed(1)}s...`,
      );
    });
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.pendingPosts) clearTimeout(timer);
    this.pendingPosts.clear();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.socket) {
      return;
    }

    if (!this.disconnectLogged) {
      this.disconnectLogged = true;
      logBlueskyEvent({
        event: 'DISCONNECT',
        filterText: this.rawFilterTexts.join(', ') || '__all__',
        endpoint: this.endpoint,
        detail: 'shutdown',
      });
    }

    const socket = this.socket;
    this.socket = null;
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else socket.close();
  }

  private deliverPost(post: GenericPost, handle: HandleEntry): void {
    const send = () => {
      if (this.stopped) return;
      post.username = handle.handle === post.authorId ? undefined : handle.handle;
      this.callbacks.onPost(post);
      this.watchHandle(post.authorId, handle);
    };
    if (handle.handle !== post.authorId) {
      send();
      return;
    }
    // Give each cache miss one second without blocking other incoming posts.
    const timer = setTimeout(() => {
      this.pendingPosts.delete(timer);
      send();
    }, USERNAME_WAIT_MS);
    this.pendingPosts.add(timer);
    timer.unref?.();
  }

  private watchHandle(did: string, entry: HandleEntry): void {
    if (entry.handle !== did || this.pendingHandles.has(did)) return;
    this.pendingHandles.add(did);
    void entry.resolved.then(username => {
      this.pendingHandles.delete(did);
      if (!this.stopped && username !== did) {
        this.callbacks.onAuthor?.({ source: 'bluesky', authorId: did, username });
      }
    });
  }

  private handleMessage(data: WebSocket.RawData): void {
    const frame = parseFrame(data);
    if (!frame) {
      return;
    }

    const posts = extractPostEntries(frame);
    if (posts.length === 0 || !frame.repo) {
      return;
    }

    for (let index = 0; index < posts.length; index += 1) {
      const postEntry = posts[index]!;
      const post = postEntry.record;
      if (!matchesLanguage(post, DEFAULT_LANGUAGE)) {
        continue;
      }

      if (
        this.filterTexts.length > 0 &&
        !this.filterTexts.some((filterText) =>
          normalizeFilter(post.text).includes(filterText),
        )
      ) {
        continue;
      }

      const handle = resolveHandle(frame.repo, this.fetcher);
      // DID links remain valid while the handle lookup runs in the background.
      const profileUrl = `https://bsky.app/profile/${encodeURIComponent(frame.repo).replaceAll('%3A', ':')}`;
      this.deliverPost({
        id: `${frame.repo}:${post.createdAt ?? frame.time ?? Date.now()}:${index}:${hashText(post.text)}`,
        source: 'bluesky',
        channelKey: this.channelKey,
        authorId: frame.repo,
        profileUrl,
        postUrl: postEntry.rkey
          ? `https://bsky.app/profile/${encodeURIComponent(frame.repo).replaceAll('%3A', ':')}/post/${encodeURIComponent(postEntry.rkey)}`
          : undefined,
        text: post.text,
        facets: extractFacets(post),
        images: extractImages(post, frame.repo),
        createdAt: formatTimestamp(post.createdAt ?? frame.time),
        language: Array.isArray(post.langs) ? post.langs[0] : undefined,
        raw: post,
      }, handle);
    }
  }
}

type BlueskyPostRecord = {
  $type?: string;
  text: string;
  createdAt?: string;
  langs?: string[];
  facets?: BlueskyFacet[];
  embed?: BlueskyEmbed;
};

type BlueskyPostEntry = {
  record: BlueskyPostRecord;
  rkey?: string;
};

type BlueskyFacet = {
  index?: {
    byteStart?: number;
    byteEnd?: number;
  };
  features?: Array<
    | {
        $type?: 'app.bsky.richtext.facet#link';
        uri?: string;
      }
    | {
        $type?: 'app.bsky.richtext.facet#mention';
        did?: string;
      }
    | {
        $type?: 'app.bsky.richtext.facet#tag';
        tag?: string;
      }
  >;
};

type BlueskyBlobRef = {
  ref?: { $link?: string } | cbor.Tagged;
  cid?: string;
};

type BlueskyImageEmbed = {
  $type?: 'app.bsky.embed.images';
  images?: Array<{
    alt?: string;
    image?: BlueskyBlobRef;
  }>;
};

type BlueskyRecordWithMediaEmbed = {
  $type?: 'app.bsky.embed.recordWithMedia';
  media?: BlueskyEmbed;
};

type BlueskyEmbed = BlueskyImageEmbed | BlueskyRecordWithMediaEmbed | { $type?: string };

function parseFrame(data: WebSocket.RawData): CommitFrame | null {
  const frames = decodeAllSync(Buffer.from(data as ArrayBufferLike));
  if (frames.length < 2) {
    return null;
  }

  const header = frames[0] as { op?: number; t?: string };
  if (header?.op !== 1 || header.t !== '#commit') {
    return null;
  }

  return frames[1] as CommitFrame;
}

function decodeVarint(bytes: Uint8Array, start: number): { value: number; nextOffset: number } {
  let value = 0;
  let shift = 0;
  let offset = start;

  while (offset < bytes.length) {
    const byte = bytes[offset]!;
    value |= (byte & 0x7f) << shift;
    offset += 1;

    if ((byte & 0x80) === 0) {
      return { value, nextOffset: offset };
    }

    shift += 7;
  }

  throw new Error('Unexpected end of buffer while decoding varint');
}

function readCidLength(bytes: Uint8Array, start: number): number {
  const first = decodeVarint(bytes, start);

  if (first.value === 18 && bytes[first.nextOffset] === 32) {
    return 34;
  }

  const second = decodeVarint(bytes, first.nextOffset);
  const third = decodeVarint(bytes, second.nextOffset);
  const fourth = decodeVarint(bytes, third.nextOffset);

  return fourth.nextOffset - start + fourth.value;
}

function decodeCarBlocks(blockBytes: Uint8Array): BlueskyPostRecord[] {
  const header = decodeVarint(blockBytes, 0);
  let offset = header.nextOffset + header.value;
  const records: BlueskyPostRecord[] = [];

  while (offset < blockBytes.length) {
    const block = decodeVarint(blockBytes, offset);
    const cidLength = readCidLength(blockBytes, block.nextOffset);
    const bodyOffset = block.nextOffset + cidLength;
    const bodyLength = block.value - cidLength;

    if (bodyLength <= 0 || bodyOffset + bodyLength > blockBytes.length) {
      break;
    }

    const body = blockBytes.subarray(bodyOffset, bodyOffset + bodyLength);
    records.push(decodeFirstSync(body) as BlueskyPostRecord);
    offset = block.nextOffset + block.value;
  }

  return records;
}

function extractPostEntries(frame: CommitFrame): BlueskyPostEntry[] {
  if (!frame.blocks) {
    return [];
  }

  const records = decodeCarBlocks(frame.blocks).filter(
    (record): record is BlueskyPostRecord =>
      record &&
      record.$type === POST_RECORD_TYPE &&
      typeof record.text === 'string',
  );
  const postRkeys = (frame.ops ?? [])
    .filter(
      (op) =>
        op.action !== 'delete' &&
        typeof op.path === 'string' &&
        op.path.startsWith(`${POST_RECORD_TYPE}/`),
    )
    .map((op) => op.path!.slice(POST_RECORD_TYPE.length + 1));

  return records.map((record, index) => ({
    record,
    rkey: postRkeys[index],
  }));
}

function matchesLanguage(post: BlueskyPostRecord, expectedLanguage: string): boolean {
  const langs = Array.isArray(post.langs) ? post.langs : [];
  if (langs.length === 0) {
    return false;
  }

  return langs.some((lang) => {
    const normalized = normalizeFilter(lang);
    return normalized === expectedLanguage || normalized.startsWith(`${expectedLanguage}-`);
  });
}

function extractFacets(post: BlueskyPostRecord): PostFacet[] | undefined {
  const facets: PostFacet[] = [];

  for (const facet of post.facets ?? []) {
      const byteStart = facet.index?.byteStart;
      const byteEnd = facet.index?.byteEnd;

      if (
        typeof byteStart !== 'number' ||
        typeof byteEnd !== 'number' ||
        byteStart < 0 ||
        byteEnd <= byteStart
      ) {
        continue;
      }

      const feature = facet.features?.[0];
      if (!feature?.$type) {
        continue;
      }

      if (feature.$type === 'app.bsky.richtext.facet#link' && feature.uri) {
        facets.push({ byteStart, byteEnd, type: 'link', uri: feature.uri });
        continue;
      }

      if (feature.$type === 'app.bsky.richtext.facet#mention' && feature.did) {
        facets.push({ byteStart, byteEnd, type: 'mention', did: feature.did });
        continue;
      }

      if (feature.$type === 'app.bsky.richtext.facet#tag' && feature.tag) {
        facets.push({ byteStart, byteEnd, type: 'tag', tag: feature.tag });
      }
  }

  facets.sort((left, right) => left.byteStart - right.byteStart);

  return facets.length > 0 ? facets : undefined;
}

function extractImages(post: BlueskyPostRecord, did: string): PostImage[] | undefined {
  const imageEmbed = unwrapImageEmbed(post.embed);
  if (!imageEmbed?.images?.length) {
    return undefined;
  }

  const images = imageEmbed.images
    .map((image) => {
      const cid = imageCid(image.image);
      if (!cid) {
        return null;
      }

      return {
        url: `https://cdn.bsky.app/img/feed_fullsize/plain/${encodeURIComponent(did)}/${encodeURIComponent(cid)}@jpeg`,
        alt: image.alt ?? '',
      };
    })
    .filter((image): image is PostImage => Boolean(image));

  return images.length > 0 ? images : undefined;
}

/** Repo frames use DAG-CBOR tag 42; JSON API records use $link or legacy cid. */
function imageCid(blob?: BlueskyBlobRef): string | undefined {
  if (!blob) return undefined;
  try {
    const ref = blob.ref;
    if (ref instanceof cbor.Tagged) {
      const bytes: unknown = ref.value;
      if (ref.tag !== 42 || !(bytes instanceof Uint8Array) || bytes[0] !== 0) return undefined;
      return CID.parse(base32.encode(bytes.subarray(1))).toString();
    }
    const cid = ref?.$link ?? blob.cid;
    return typeof cid === 'string' ? CID.parse(cid).toString() : undefined;
  } catch {
    // A bad attachment must not discard the post or its other images.
    return undefined;
  }
}

function unwrapImageEmbed(embed?: BlueskyEmbed): BlueskyImageEmbed | undefined {
  if (!embed) {
    return undefined;
  }

  if (embed.$type === 'app.bsky.embed.images') {
    return embed as BlueskyImageEmbed;
  }

  if (embed.$type === 'app.bsky.embed.recordWithMedia') {
    return unwrapImageEmbed((embed as BlueskyRecordWithMediaEmbed).media);
  }

  return undefined;
}

function formatTimestamp(value?: string): string {
  if (!value) {
    return new Date().toISOString();
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function hashText(text: string): string {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash).toString(36);
}

function resolveHandle(did: string, fetcher: typeof fetch): HandleEntry {
  const cached = handleCache.get(did);
  if (cached) return cached;

  if (handleCache.size >= MAX_CACHED_HANDLES) {
    handleCache.delete(handleCache.keys().next().value!);
  }
  const entry: HandleEntry = { handle: did, resolved: Promise.resolve(did) };
  handleCache.set(did, entry);
  entry.resolved = (async () => {
    try {
      const response = await fetcher(
        `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) return did;
      const data = (await response.json()) as { handle?: string };
      if (data.handle) entry.handle = data.handle;
    } catch {
      // Keep the DID fallback if this lookup fails.
    }
    return entry.handle;
  })();
  return entry;
}

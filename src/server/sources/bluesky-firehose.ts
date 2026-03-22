import cbor from 'cbor';
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

const handleCache = new Map<string, Promise<string>>();

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

  constructor(config: {
    channelKey: string;
    filterTexts: string[];
    callbacks: SourceCallbacks;
    endpoint?: string;
  }) {
    this.channelKey = config.channelKey;
    this.filterTexts = normalizeFilters(config.filterTexts);
    this.rawFilterTexts = config.filterTexts;
    this.callbacks = config.callbacks;
    this.endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
  }

  start(): void {
    this.disconnectLogged = false;
    this.socket = new WebSocket(this.endpoint, {
      perMessageDeflate: false,
    });

    this.socket.on('open', () => {
      logBlueskyEvent({
        event: 'CONNECT',
        filterText: this.rawFilterTexts.join(', ') || '__all__',
        endpoint: this.endpoint,
      });
      this.callbacks.onSystemMessage(`Connected to ${this.endpoint}`);
    });

    this.socket.on('message', (data) => {
      void this.handleMessage(data);
    });

    this.socket.on('error', (error) => {
      this.callbacks.onSystemMessage(`Firehose error: ${error.message}`);
    });

    this.socket.on('close', (code, reason) => {
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
      this.callbacks.onSystemMessage(`Firehose closed with code ${code}${detail}`);
    });
  }

  stop(): void {
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

    this.socket.close();
    this.socket = null;
  }

  private async handleMessage(data: WebSocket.RawData): Promise<void> {
    const frame = parseFrame(data);
    if (!frame) {
      return;
    }

    const posts = extractPostEntries(frame);
    if (posts.length === 0 || !frame.repo) {
      return;
    }

    const username = await resolveHandle(frame.repo);
    const profileUrl = `https://bsky.app/profile/${encodeURIComponent(username)}`;

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

      this.callbacks.onPost({
        id: `${frame.repo}:${post.createdAt ?? frame.time ?? Date.now()}:${index}:${hashText(post.text)}`,
        source: 'bluesky',
        channelKey: this.channelKey,
        authorId: frame.repo,
        username,
        profileUrl,
        postUrl: postEntry.rkey
          ? `https://bsky.app/profile/${encodeURIComponent(username)}/post/${encodeURIComponent(postEntry.rkey)}`
          : undefined,
        text: post.text,
        facets: extractFacets(post),
        images: extractImages(post, frame.repo),
        createdAt: formatTimestamp(post.createdAt ?? frame.time),
        language: Array.isArray(post.langs) ? post.langs[0] : undefined,
        raw: post,
      });
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
  ref?: {
    $link?: string;
  };
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
      const cid = image.image?.ref?.$link;
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

async function resolveHandle(did: string): Promise<string> {
  const cached = handleCache.get(did);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    try {
      const response = await fetch(
        `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
        { signal: AbortSignal.timeout(10_000) },
      );

      if (!response.ok) {
        throw new Error(`profile lookup failed with ${response.status}`);
      }

      const data = (await response.json()) as { handle?: string };
      return data.handle || did;
    } catch {
      return did;
    }
  })();

  handleCache.set(did, promise);
  return promise;
}

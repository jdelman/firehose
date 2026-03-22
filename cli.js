#!/usr/bin/env node

import readline from 'node:readline';
import cbor from 'cbor';
import WebSocket from 'ws';

const { decodeAllSync, decodeFirstSync } = cbor;

const DEFAULT_ENDPOINT =
  process.env.BLUESKY_FIREHOSE_URL ??
  'wss://bsky.network/xrpc/com.atproto.sync.subscribeRepos';

const POST_RECORD_TYPE = 'app.bsky.feed.post';
const STATUS_INTERVAL_MS = 1000;
const SUMMARY_INTERVAL_MS = 10_000;
const SUMMARY_MODEL = 'gpt-5-mini-2025-08-07';
const FOOTER_SUMMARY_LINES = 4;
const HELP_TEXT = `Stream Bluesky posts from the ATProto firehose.

Usage:
  node cli.js [--filter WORD] [--lang CODE] [--summarize] [--endpoint URL]

Options:
  --filter WORD   Only print posts whose body contains WORD (case-insensitive)
  --lang CODE     Only print posts tagged with CODE. Default: en
  --summarize     Every 10 seconds, summarize the last 10 seconds of post bodies
  --endpoint URL  Override the firehose WebSocket endpoint
  -h, --help      Show this help text
`;

function parseArgs(argv) {
  const args = {
    endpoint: DEFAULT_ENDPOINT,
    filter: '',
    lang: 'en',
    summarize: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }

    if (token === '--filter') {
      args.filter = argv[i + 1] ?? '';
      i += 1;
      continue;
    }

    if (token === '--endpoint') {
      args.endpoint = argv[i + 1] ?? DEFAULT_ENDPOINT;
      i += 1;
      continue;
    }

    if (token === '--lang') {
      args.lang = (argv[i + 1] ?? 'en').toLowerCase();
      i += 1;
      continue;
    }

    if (token === '--summarize') {
      args.summarize = true;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function decodeVarint(bytes, start) {
  let value = 0;
  let shift = 0;
  let offset = start;

  while (offset < bytes.length) {
    const byte = bytes[offset];
    value |= (byte & 0x7f) << shift;
    offset += 1;

    if ((byte & 0x80) === 0) {
      return { value, nextOffset: offset };
    }

    shift += 7;
  }

  throw new Error('Unexpected end of buffer while decoding varint');
}

function readCidLength(bytes, start) {
  const first = decodeVarint(bytes, start);

  if (first.value === 18 && bytes[first.nextOffset] === 32) {
    return 34;
  }

  const second = decodeVarint(bytes, first.nextOffset);
  const third = decodeVarint(bytes, second.nextOffset);
  const fourth = decodeVarint(bytes, third.nextOffset);

  return fourth.nextOffset - start + fourth.value;
}

function decodeCarBlocks(blockBytes) {
  const bytes = Buffer.isBuffer(blockBytes)
    ? blockBytes
    : Buffer.from(blockBytes ?? []);
  const header = decodeVarint(bytes, 0);
  let offset = header.nextOffset + header.value;
  const records = [];

  while (offset < bytes.length) {
    const block = decodeVarint(bytes, offset);
    const cidLength = readCidLength(bytes, block.nextOffset);
    const bodyOffset = block.nextOffset + cidLength;
    const bodyLength = block.value - cidLength;

    if (bodyLength <= 0 || bodyOffset + bodyLength > bytes.length) {
      break;
    }

    const body = bytes.subarray(bodyOffset, bodyOffset + bodyLength);
    records.push(decodeFirstSync(body));
    offset = block.nextOffset + block.value;
  }

  return records;
}

function extractPostRecords(commit) {
  if (!commit?.blocks) {
    return [];
  }

  const records = decodeCarBlocks(commit.blocks);
  return records.filter(
    (record) =>
      record &&
      typeof record === 'object' &&
      record.$type === POST_RECORD_TYPE &&
      typeof record.text === 'string',
  );
}

function normalizeText(text) {
  return typeof text === 'string' ? text.toLowerCase() : '';
}

function formatTimestamp(value) {
  if (!value) {
    return new Date().toISOString();
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function matchesLanguage(post, expectedLanguage) {
  if (!expectedLanguage) {
    return true;
  }

  const langs = Array.isArray(post?.langs) ? post.langs : [];
  if (langs.length === 0) {
    return false;
  }

  return langs.some((lang) => {
    if (typeof lang !== 'string') {
      return false;
    }

    const normalized = lang.toLowerCase();
    return (
      normalized === expectedLanguage ||
      normalized.startsWith(`${expectedLanguage}-`)
    );
  });
}

const handleCache = new Map();

async function resolveHandle(did) {
  if (!did) {
    return 'unknown';
  }

  const cached = handleCache.get(did);
  if (cached) {
    return cached;
  }

  const lookup = (async () => {
    try {
      const response = await fetch(
        `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
        { signal: AbortSignal.timeout(10000) },
      );

      if (!response.ok) {
        throw new Error(`profile lookup failed with ${response.status}`);
      }

      const profile = await response.json();
      return profile.handle || did;
    } catch {
      return did;
    }
  })();

  handleCache.set(did, lookup);
  return lookup;
}

function parseFrame(data) {
  const frames = decodeAllSync(Buffer.from(data));
  if (frames.length < 2) {
    return null;
  }

  return {
    header: frames[0],
    body: frames[1],
  };
}

function isCommitFrame(frame) {
  return frame?.header?.op === 1 && frame.header.t === '#commit' && frame.body;
}

function printPost({ handle, time, text }) {
  process.stdout.write(`${time}  ${handle}\n${text}\n\n`);
}

function wrapText(text, width) {
  const normalizedWidth = Math.max(width ?? 80, 20);
  const source = String(text ?? '').trim();

  if (!source) {
    return [''];
  }

  const segments = source.split(/\r?\n/);
  const lines = [];

  for (const segment of segments) {
    const words = segment.split(/\s+/).filter(Boolean);

    if (words.length === 0) {
      lines.push('');
      continue;
    }

    let line = '';

    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;

      if (candidate.length <= normalizedWidth) {
        line = candidate;
        continue;
      }

      if (line) {
        lines.push(line);
      }

      if (word.length <= normalizedWidth) {
        line = word;
        continue;
      }

      let offset = 0;
      while (offset < word.length) {
        const chunk = word.slice(offset, offset + normalizedWidth);
        if (chunk.length === normalizedWidth) {
          lines.push(chunk);
          offset += normalizedWidth;
        } else {
          line = chunk;
          offset = word.length;
        }
      }

      if (offset === word.length && word.length % normalizedWidth === 0) {
        line = '';
      }
    }

    if (line || words.length > 0) {
      lines.push(line);
    }
  }

  return lines.length > 0 ? lines : [''];
}

function truncateLines(lines, maxLines, width) {
  if (lines.length <= maxLines) {
    return lines;
  }

  const result = lines.slice(0, maxLines);
  const ellipsis = '...';
  const lastLine = result[maxLines - 1] || '';
  const maxWidth = Math.max(width ?? 80, ellipsis.length + 1);
  const trimmed = lastLine.slice(0, Math.max(maxWidth - ellipsis.length, 0));
  result[maxLines - 1] = `${trimmed}${ellipsis}`;
  return result;
}

function padLines(lines, targetLength) {
  const result = lines.slice(0, targetLength);

  while (result.length < targetLength) {
    result.push('');
  }

  return result;
}

function extractResponseText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  if (
    typeof response?.output_text?.text === 'string' &&
    response.output_text.text.trim()
  ) {
    return response.output_text.text.trim();
  }

  const output = Array.isArray(response?.output) ? response.output : [];
  const chunks = [];

  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const text =
        part?.text ??
        part?.output_text ??
        part?.content?.[0]?.text ??
        part?.content?.[0]?.output_text;
      if (typeof text === 'string' && text.trim()) {
        chunks.push(text.trim());
      }
    }
  }

  return chunks.join('\n').trim();
}

function describeResponseWithoutText(response) {
  const status = response?.status;
  const reason = response?.incomplete_details?.reason;
  const outputTypes = Array.isArray(response?.output)
    ? response.output.map((item) => item?.type).filter(Boolean).join(', ')
    : 'none';

  if (status === 'incomplete' && reason) {
    return `summary response incomplete (${reason})`;
  }

  return `summary response had no text (status: ${status ?? 'unknown'}, output: ${outputTypes})`;
}

function createStatusRenderer({ intervalMs = STATUS_INTERVAL_MS } = {}) {
  if (!process.stdout.isTTY) {
    return {
      notePost() {},
      start() {},
      beforeOutput() {},
      afterOutput() {},
      setSummary() {},
      stop() {},
    };
  }

  let totalPosts = 0;
  const recentPostTimes = [];
  let summaryText = 'Summary: disabled';
  let summaryState = '';
  let footerVisible = false;
  let timer = null;

  function pruneRecentPosts(now) {
    const cutoff = now - 60_000;

    while (recentPostTimes.length > 0 && recentPostTimes[0] < cutoff) {
      recentPostTimes.shift();
    }
  }

  function renderStatus() {
    const now = Date.now();
    pruneRecentPosts(now);
    const postsPerSecond = recentPostTimes.length / 60;
    const width = process.stdout.columns ?? 80;
    const innerWidth = Math.max(width - 4, 20);
    const divider = `+${'-'.repeat(Math.max(width - 2, 1))}+`;
    const suffix = summaryState ? ` | Summary: ${summaryState}` : '';
    const status = `Posts/sec: ${postsPerSecond.toFixed(2)} | Total posts: ${totalPosts}${suffix}`;
    const summaryLines = padLines(
      truncateLines(wrapText(summaryText, innerWidth), FOOTER_SUMMARY_LINES, innerWidth),
      FOOTER_SUMMARY_LINES,
    );
    const panelLines = [status, ...summaryLines].map((line) => {
      const clipped = line.slice(0, innerWidth);
      return `| ${clipped.padEnd(innerWidth, ' ')} |`;
    });

    clearFooter();
    process.stdout.write([divider, ...panelLines].join('\n'));
    footerVisible = true;
  }

  function clearFooter() {
    if (!footerVisible) {
      return;
    }

    for (let i = 0; i < FOOTER_SUMMARY_LINES + 2; i += 1) {
      readline.clearLine(process.stdout, 0);
      if (i < FOOTER_SUMMARY_LINES + 1) {
        readline.moveCursor(process.stdout, 0, -1);
      }
    }

    readline.cursorTo(process.stdout, 0);
    footerVisible = false;
  }

  return {
    notePost() {
      const now = Date.now();
      totalPosts += 1;
      recentPostTimes.push(now);
      pruneRecentPosts(now);
    },
    start() {
      renderStatus();
      timer = setInterval(renderStatus, intervalMs);
      timer.unref?.();
    },
    beforeOutput() {
      clearFooter();
    },
    afterOutput() {
      renderStatus();
    },
    setSummary(nextSummary) {
      summaryText = nextSummary;
      renderStatus();
    },
    setSummaryState(nextState) {
      summaryState = nextState;
      renderStatus();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }

      clearFooter();
    },
  };
}

function createSummarizer({ enabled, onSummary }) {
  const setSummary = onSummary?.setSummary;
  const setSummaryState = onSummary?.setSummaryState;

  if (!enabled) {
    setSummary?.('Summary disabled.');
    setSummaryState?.('');
    return {
      notePost() {},
      start() {},
      stop() {},
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    setSummary?.('Summary unavailable: missing OPENAI_API_KEY.');
    setSummaryState?.('');
    return {
      notePost() {},
      start() {},
      stop() {},
    };
  }

  const recentPosts = [];
  let timer = null;
  let inFlight = false;

  function collectPosts() {
    const posts = recentPosts.slice();
    recentPosts.length = 0;
    return posts;
  }

  async function requestSummary(posts) {
    const preamble = [
      'You will receive a list of Bluesky post bodies from the last 10 seconds.',
      'Write one very terse plain-text summary of what people are talking about.',
      'If there is an off-kilter or surprising message, mention it briefly.',
      'Keep the entire response under 200 characters.',
      'Do not use bullets, labels, or preamble.',
    ].join(' ');

    const body = {
      model: SUMMARY_MODEL,
      instructions: preamble,
      input: posts.join('\n\n'),
      reasoning: {
        effort: 'minimal',
      },
      text: {
        verbosity: 'low',
      },
      max_output_tokens: 120,
    };

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`summary request failed with ${response.status}`);
    }

    const data = await response.json();
    const text = extractResponseText(data);
    if (text) {
      return text;
    }

    throw new Error(describeResponseWithoutText(data));
  }

  async function tick() {
    if (inFlight) {
      return;
    }

    const posts = collectPosts();
    if (posts.length === 0) {
      setSummary?.('No matching posts in the last 10 seconds.');
      setSummaryState?.('');
      return;
    }

    inFlight = true;
    setSummaryState?.('updating');

    try {
      const summary = await requestSummary(posts);
      setSummary?.(summary);
      setSummaryState?.('');
    } catch (error) {
      setSummary?.(`Unavailable: ${error.message}`);
      setSummaryState?.('');
    } finally {
      inFlight = false;
    }
  }

  return {
    notePost(text) {
      if (typeof text === 'string' && text.trim()) {
        recentPosts.push(text.trim());
      }
    },
    start() {
      setSummary?.('Waiting for the first 10-second window.');
      setSummaryState?.('');
      timer = setInterval(() => {
        void tick();
      }, SUMMARY_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

export function streamPosts({
  endpoint = DEFAULT_ENDPOINT,
  filter = '',
  lang = 'en',
  summarize = false,
} = {}) {
  const normalizedFilter = normalizeText(filter);
  const normalizedLang = normalizeText(lang);
  const status = createStatusRenderer();
  const summarizer = createSummarizer({
    enabled: summarize,
    onSummary: {
      setSummary: (text) => status.setSummary(text),
      setSummaryState: (state) => status.setSummaryState(state),
    },
  });
  const socket = new WebSocket(endpoint, { perMessageDeflate: false });

  socket.on('open', () => {
    console.error(`connected to ${endpoint}`);
    status.start();
    summarizer.start();
  });

  socket.on('message', async (data) => {
    let frame;

    try {
      frame = parseFrame(data);
    } catch (error) {
      console.error(`failed to decode message: ${error.message}`);
      return;
    }

    if (!isCommitFrame(frame)) {
      return;
    }

    const posts = extractPostRecords(frame.body);
    if (posts.length === 0) {
      return;
    }

    const handle = await resolveHandle(frame.body.repo);

    for (const post of posts) {
      if (!matchesLanguage(post, normalizedLang)) {
        continue;
      }

      if (
        normalizedFilter &&
        !normalizeText(post.text).includes(normalizedFilter)
      ) {
        continue;
      }

      status.notePost();
      summarizer.notePost(post.text);
      status.beforeOutput();
      printPost({
        handle,
        text: post.text,
        time: formatTimestamp(post.createdAt ?? frame.body.time),
      });
      status.afterOutput();
    }
  });

  socket.on('error', (error) => {
    console.error(`firehose error: ${error.message}`);
  });

  socket.on('close', (code, reason) => {
    summarizer.stop();
    status.stop();
    const detail = reason ? ` (${reason.toString()})` : '';
    console.error(`firehose closed with code ${code}${detail}`);
  });

  return socket;
}

function runCli() {
  let args;

  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error('');
    process.stderr.write(HELP_TEXT);
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  streamPosts({
    endpoint: args.endpoint,
    filter: args.filter,
    lang: args.lang,
    summarize: args.summarize,
  });
}

runCli();

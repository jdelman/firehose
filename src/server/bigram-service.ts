import type { BigramSnapshot } from './models/events.ts';

const STOP_WORDS = new Set([
  'i',
  'me',
  'my',
  'myself',
  'we',
  'our',
  'ours',
  'ourselves',
  'you',
  'your',
  'yours',
  'yourself',
  'yourselves',
  'he',
  'him',
  'his',
  'himself',
  'she',
  'her',
  'hers',
  'herself',
  'it',
  'its',
  'itself',
  'they',
  'them',
  'their',
  'theirs',
  'themselves',
  'what',
  'which',
  'who',
  'whom',
  'this',
  'that',
  'these',
  'those',
  'am',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'having',
  'do',
  'does',
  'did',
  'doing',
  'a',
  'an',
  'the',
  'and',
  'but',
  'if',
  'or',
  'because',
  'as',
  'until',
  'while',
  'of',
  'at',
  'by',
  'for',
  'with',
  'about',
  'against',
  'between',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'to',
  'from',
  'up',
  'down',
  'in',
  'out',
  'on',
  'off',
  'over',
  'under',
  'again',
  'further',
  'then',
  'once',
  'here',
  'there',
  'when',
  'where',
  'why',
  'how',
  'all',
  'any',
  'both',
  'each',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'nor',
  'not',
  'only',
  'own',
  'same',
  'so',
  'than',
  'too',
  'very',
  's',
  't',
  'can',
  'will',
  'just',
  'don',
  'should',
  'now',
]);

export class ChannelBigramService {
  private readonly counts = new Map<string, number>();
  private readonly onUpdate: (snapshot: BigramSnapshot) => void;
  private snapshot: BigramSnapshot = {
    items: [],
    updatedAt: null,
  };

  constructor(onUpdate: (snapshot: BigramSnapshot) => void) {
    this.onUpdate = onUpdate;
  }

  getSnapshot(): BigramSnapshot {
    return this.snapshot;
  }

  start(): void {
    this.publish();
  }

  stop(): void {}

  reset(): void {
    this.counts.clear();
    this.snapshot = {
      items: [],
      updatedAt: new Date().toISOString(),
    };
    this.publish();
  }

  notePost(text: string): void {
    const tokens = tokenize(text).filter((token) => !STOP_WORDS.has(token));
    if (tokens.length < 2) {
      return;
    }

    for (let index = 0; index < tokens.length - 1; index += 1) {
      const left = tokens[index]!;
      const right = tokens[index + 1]!;
      if (isNumericToken(left) && isNumericToken(right)) {
        continue;
      }

      const bigram = `${left} ${right}`;
      this.counts.set(bigram, (this.counts.get(bigram) ?? 0) + 1);
    }

    this.snapshot = {
      items: [...this.counts.entries()]
        .sort((left, right) => {
          if (right[1] !== left[1]) {
            return right[1] - left[1];
          }

          return left[0].localeCompare(right[0]);
        })
        .slice(0, 10)
        .map(([phrase, count]) => ({ phrase, count })),
      updatedAt: new Date().toISOString(),
    };
    this.publish();
  }

  private publish(): void {
    this.onUpdate({ ...this.snapshot, items: [...this.snapshot.items] });
  }
}

function tokenize(text: string): string[] {
  const sanitized = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/\B[@#][a-z0-9_]+\b/gi, ' ');

  const tokens: string[] = [];

  for (const rawChunk of sanitized.split(/\s+/)) {
    const chunk = rawChunk.replace(/^[^a-z0-9]+|[^a-z0-9./:-]+$/gi, '');
    if (!chunk || isUrlLikeChunk(chunk)) {
      continue;
    }

    tokens.push(...(chunk.match(/[a-z0-9]+/g) ?? []));
  }

  return tokens;
}

function isUrlLikeChunk(chunk: string): boolean {
  return (
    /^(?:https?|www)$/i.test(chunk) ||
    /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]\S*)?$/i.test(chunk)
  );
}

function isNumericToken(token: string): boolean {
  return /^\d+$/.test(token);
}

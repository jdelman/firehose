import type { AuthorUpdate, GenericPost } from '../models/post.ts';

export type SourceName = 'bluesky' | 'x';

export function normalizeSources(sources: string[] = ['bluesky']): SourceName[] {
  return [...new Set(sources.filter((source): source is SourceName => source === 'bluesky' || source === 'x'))].sort();
}

export function sourceChannelKey(filterKey: string, sources: SourceName[]): string {
  return sources.length === 1 && sources[0] === 'bluesky'
    ? filterKey : JSON.stringify([sources, filterKey]);
}

export type SourceCallbacks = {
  onPost: (post: GenericPost) => void;
  onAuthor?: (author: AuthorUpdate) => void;
  onSystemMessage: (message: string) => void;
};

export type PostSourceAdapter = {
  getBlueskyConnectionCount?(): number;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
};

export type PostSourceFactory = (config: {
  sources: SourceName[];
  channelKey: string;
  filterTexts: string[];
  callbacks: SourceCallbacks;
}) => PostSourceAdapter;

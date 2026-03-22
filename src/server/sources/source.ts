import type { GenericPost } from '../models/post.ts';

export type SourceCallbacks = {
  onPost: (post: GenericPost) => void;
  onSystemMessage: (message: string) => void;
};

export type PostSourceAdapter = {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
};

export type PostSourceFactory = (config: {
  channelKey: string;
  filterTexts: string[];
  callbacks: SourceCallbacks;
}) => PostSourceAdapter;

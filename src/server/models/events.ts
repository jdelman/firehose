import type { GenericPost } from './post.ts';

export type ChannelStats = {
  postsPerSecond: number;
  totalPosts: number;
  subscriberCount: number;
};

export type SummaryStatus = 'idle' | 'updating' | 'error';

export type SummarySnapshot = {
  text: string;
  keywords: Record<string, string[]>;
  updatedAt: string | null;
  status: SummaryStatus;
};

export type BigramSnapshot = {
  items: Array<{
    phrase: string;
    count: number;
  }>;
  updatedAt: string | null;
};

export type PostEvent = {
  type: 'post';
  data: GenericPost;
};

export type StatsEvent = {
  type: 'stats';
  data: ChannelStats;
};

export type SummaryEvent = {
  type: 'summary';
  data: SummarySnapshot;
};

export type BigramsEvent = {
  type: 'bigrams';
  data: BigramSnapshot;
};

export type SystemEvent = {
  type: 'system';
  data: {
    message: string;
  };
};

export type ChannelEvent =
  | PostEvent
  | StatsEvent
  | SummaryEvent
  | BigramsEvent
  | SystemEvent;

export function serializeSseEvent(event: ChannelEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

import type {
  BigramSnapshot,
  ChannelEvent,
  ChannelStats,
  SummarySnapshot,
} from './models/events.ts';
import { ChannelBigramService } from './bigram-service.ts';
import { normalizeFilters, toChannelKey } from './models/post.ts';
import type { GenericPost } from './models/post.ts';
import type { PubSubAdapter } from './pubsub/pubsub.ts';
import {
  ChannelSummaryService,
  generateOpenRouterSummary,
  type SummaryGenerator,
} from './summary-service.ts';
import type { PostSourceAdapter, PostSourceFactory } from './sources/source.ts';
import { normalizeSources, sourceChannelKey, type SourceName } from './sources/source.ts';

const POST_RATE_WINDOW_MS = 5_000;

type ChannelRecord = {
  channelKey: string;
  filterTexts: string[];
  source: PostSourceAdapter;
  summaryService: ChannelSummaryService;
  bigramService: ChannelBigramService;
  subscriberCount: number;
  totalPosts: number;
  recentPostTimes: number[];
  latestSummary: SummarySnapshot;
  latestBigrams: BigramSnapshot;
  systemMessages: Map<string, string>;
  statsTimer: Timer | null;
};

export type ChannelSnapshot = {
  systemMessages: string[];
  stats: ChannelStats;
  summary: SummarySnapshot;
  bigrams: BigramSnapshot;
};

export class ChannelRegistry {
  private readonly channels = new Map<string, ChannelRecord>();
  private readonly pubsub: PubSubAdapter;
  private readonly createSource: PostSourceFactory;
  private readonly statsIntervalMs: number;
  private readonly summaryGenerator: SummaryGenerator;
  private readonly summaryIntervalMs: number | undefined;

  constructor(config: {
    pubsub: PubSubAdapter;
    createSource: PostSourceFactory;
    statsIntervalMs?: number;
    summaryGenerator?: SummaryGenerator;
    summaryIntervalMs?: number;
  }) {
    this.pubsub = config.pubsub;
    this.createSource = config.createSource;
    this.statsIntervalMs = config.statsIntervalMs ?? 1_000;
    this.summaryGenerator = config.summaryGenerator ?? generateOpenRouterSummary;
    this.summaryIntervalMs = config.summaryIntervalMs;
  }

  subscribe(config: {
    sources?: SourceName[];
    filterTexts: string[];
    listener: (event: ChannelEvent) => void;
  }): {
    channelKey: string;
    snapshot: ChannelSnapshot;
    unsubscribe: () => Promise<void>;
  } {
    const filterTexts = normalizeFilters(config.filterTexts);
    const sources = normalizeSources(config.sources);
    const channelKey = sourceChannelKey(toChannelKey(filterTexts), sources);
    const channel = this.getOrCreateChannel(channelKey, filterTexts, sources);
    channel.subscriberCount += 1;

    const unsubscribePubSub = this.pubsub.subscribe(channelKey, config.listener);
    this.publishStats(channel);

    return {
      channelKey,
      snapshot: {
        systemMessages: [...channel.systemMessages.values()],
        stats: this.buildStats(channel),
        summary: channel.latestSummary,
        bigrams: channel.latestBigrams,
      },
      unsubscribe: async () => {
        unsubscribePubSub();

        const currentChannel = this.channels.get(channelKey);
        if (!currentChannel) {
          return;
        }

        currentChannel.subscriberCount = Math.max(currentChannel.subscriberCount - 1, 0);
        this.publishStats(currentChannel);

        if (currentChannel.subscriberCount === 0) {
          await this.destroyChannel(channelKey);
        }
      },
    };
  }

  resetBigrams(filterTexts: string[], sources?: SourceName[]): void {
    const channelKey = sourceChannelKey(toChannelKey(filterTexts), normalizeSources(sources));
    const channel = this.channels.get(channelKey);
    if (!channel) {
      return;
    }

    channel.bigramService.reset();
  }

  private getOrCreateChannel(channelKey: string, filterTexts: string[], sources: SourceName[]): ChannelRecord {
    const existing = this.channels.get(channelKey);
    if (existing) {
      return existing;
    }

    const latestSummary: SummarySnapshot = {
      text: 'Waiting for the first 10-second window.',
      keywords: {},
      updatedAt: null,
      status: 'idle',
    };

    const summaryService = new ChannelSummaryService({
      compareSources: sources.includes('bluesky') && sources.includes('x'),
      intervalMs: this.summaryIntervalMs,
      generateSummary: this.summaryGenerator,
      onUpdate: (summary) => {
        const channel = this.channels.get(channelKey);
        if (!channel) {
          return;
        }

        channel.latestSummary = summary;
        this.pubsub.publish(channelKey, {
          type: 'summary',
          data: summary,
        });
      },
    });

    const bigramService = new ChannelBigramService((bigrams) => {
      const channel = this.channels.get(channelKey);
      if (!channel) {
        return;
      }

      channel.latestBigrams = bigrams;
      this.pubsub.publish(channelKey, {
        type: 'bigrams',
        data: bigrams,
      });
    });

    const source = this.createSource({
      sources,
      channelKey,
      filterTexts,
      callbacks: {
        onPost: (post) => {
          const channel = this.channels.get(channelKey);
          if (!channel) {
            return;
          }

          this.handlePost(channel, post);
        },
        onAuthor: (author) => {
          if (!this.channels.has(channelKey)) return;
          this.pubsub.publish(channelKey, { type: 'author', data: author });
        },
        onSystemMessage: (message) => {
          const source = message.startsWith('X ') || message.startsWith('An X ') ? 'x' : 'bluesky';
          this.channels.get(channelKey)?.systemMessages.set(source, message);
          this.pubsub.publish(channelKey, {
            type: 'system',
            data: { message },
          });
        },
      },
    });

    const channel: ChannelRecord = {
      channelKey,
      filterTexts,
      source,
      summaryService,
      bigramService,
      subscriberCount: 0,
      totalPosts: 0,
      recentPostTimes: [],
      latestSummary,
      systemMessages: new Map(),
      latestBigrams: {
        items: [],
        updatedAt: null,
      },
      statsTimer: null,
    };

    this.channels.set(channelKey, channel);
    channel.statsTimer = setInterval(() => {
      const currentChannel = this.channels.get(channelKey);
      if (!currentChannel) {
        return;
      }

      this.publishStats(currentChannel);
    }, this.statsIntervalMs);
    channel.statsTimer.unref?.();

    summaryService.start();
    bigramService.start();
    void source.start();

    return channel;
  }

  private buildStats(channel: ChannelRecord): ChannelStats {
    const now = Date.now();
    const cutoff = now - POST_RATE_WINDOW_MS;

    while (channel.recentPostTimes.length > 0 && channel.recentPostTimes[0]! < cutoff) {
      channel.recentPostTimes.shift();
    }

    return {
      postsPerSecond: channel.recentPostTimes.length / (POST_RATE_WINDOW_MS / 1_000),
      totalPosts: channel.totalPosts,
      subscriberCount: channel.subscriberCount,
    };
  }

  private publishStats(channel: ChannelRecord): void {
    this.pubsub.publish(channel.channelKey, {
      type: 'stats',
      data: this.buildStats(channel),
    });
  }

  private handlePost(channel: ChannelRecord, post: GenericPost): void {
    channel.totalPosts += 1;
    channel.recentPostTimes.push(Date.now());
    channel.summaryService.notePost(post.text, post.source, post.id);
    channel.bigramService.notePost(post.text);

    this.pubsub.publish(channel.channelKey, {
      type: 'post',
      data: post,
    });
    this.publishStats(channel);
  }

  private async destroyChannel(channelKey: string): Promise<void> {
    const channel = this.channels.get(channelKey);
    if (!channel) {
      return;
    }

    if (channel.statsTimer) {
      clearInterval(channel.statsTimer);
      channel.statsTimer = null;
    }

    channel.summaryService.stop();
    channel.bigramService.stop();
    this.pubsub.closeChannel(channelKey);
    this.channels.delete(channelKey);
    await channel.source.stop();
  }
}

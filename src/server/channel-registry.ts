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
  generateOpenAiSummary,
  type SummaryGenerator,
} from './summary-service.ts';
import type { PostSourceAdapter, PostSourceFactory } from './sources/source.ts';

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
  statsTimer: Timer | null;
};

export type ChannelSnapshot = {
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
    this.summaryGenerator = config.summaryGenerator ?? generateOpenAiSummary;
    this.summaryIntervalMs = config.summaryIntervalMs;
  }

  subscribe(config: {
    filterTexts: string[];
    listener: (event: ChannelEvent) => void;
  }): {
    channelKey: string;
    snapshot: ChannelSnapshot;
    unsubscribe: () => Promise<void>;
  } {
    const filterTexts = normalizeFilters(config.filterTexts);
    const channelKey = toChannelKey(filterTexts);
    const channel = this.getOrCreateChannel(channelKey, filterTexts);
    channel.subscriberCount += 1;

    const unsubscribePubSub = this.pubsub.subscribe(channelKey, config.listener);
    this.publishStats(channel);

    return {
      channelKey,
      snapshot: {
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

  resetBigrams(filterTexts: string[]): void {
    const channelKey = toChannelKey(filterTexts);
    const channel = this.channels.get(channelKey);
    if (!channel) {
      return;
    }

    channel.bigramService.reset();
  }

  private getOrCreateChannel(channelKey: string, filterTexts: string[]): ChannelRecord {
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
        onSystemMessage: (message) => {
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
    const cutoff = now - 60_000;

    while (channel.recentPostTimes.length > 0 && channel.recentPostTimes[0]! < cutoff) {
      channel.recentPostTimes.shift();
    }

    return {
      postsPerSecond: channel.recentPostTimes.length / 60,
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
    channel.summaryService.notePost(post.text);
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
    await channel.source.stop();
    this.pubsub.closeChannel(channelKey);
    this.channels.delete(channelKey);
  }
}

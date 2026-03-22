import type { PubSubAdapter, PubSubSubscriber } from './pubsub.ts';
import type { ChannelEvent } from '../models/events.ts';

export class InMemoryPubSubAdapter implements PubSubAdapter {
  private readonly channels = new Map<string, Set<PubSubSubscriber>>();

  publish(channelKey: string, event: ChannelEvent): void {
    const subscribers = this.channels.get(channelKey);
    if (!subscribers) {
      return;
    }

    for (const subscriber of subscribers) {
      subscriber(event);
    }
  }

  subscribe(channelKey: string, subscriber: PubSubSubscriber): () => void {
    const subscribers = this.channels.get(channelKey) ?? new Set<PubSubSubscriber>();
    subscribers.add(subscriber);
    this.channels.set(channelKey, subscribers);

    return () => {
      const currentSubscribers = this.channels.get(channelKey);
      if (!currentSubscribers) {
        return;
      }

      currentSubscribers.delete(subscriber);
      if (currentSubscribers.size === 0) {
        this.channels.delete(channelKey);
      }
    };
  }

  subscriberCount(channelKey: string): number {
    return this.channels.get(channelKey)?.size ?? 0;
  }

  closeChannel(channelKey: string): void {
    this.channels.delete(channelKey);
  }
}

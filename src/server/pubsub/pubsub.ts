import type { ChannelEvent } from '../models/events.ts';

export type PubSubSubscriber = (event: ChannelEvent) => void;

export interface PubSubAdapter {
  publish(channelKey: string, event: ChannelEvent): void;
  subscribe(channelKey: string, subscriber: PubSubSubscriber): () => void;
  subscriberCount(channelKey: string): number;
  closeChannel(channelKey: string): void;
}

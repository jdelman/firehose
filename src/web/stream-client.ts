export type PostFacet = {
  byteStart: number;
  byteEnd: number;
  type: 'link' | 'mention' | 'tag';
  uri?: string;
  did?: string;
  tag?: string;
};

export type PostImage = {
  url: string;
  alt: string;
};

export type GenericPost = {
  id: string;
  username: string;
  profileUrl?: string;
  postUrl?: string;
  text: string;
  facets?: PostFacet[];
  images?: PostImage[];
  createdAt: string;
};

export type ChannelStats = {
  postsPerSecond: number;
  totalPosts: number;
  subscriberCount: number;
};

export type SummarySnapshot = {
  text: string;
  keywords: Record<string, string[]>;
  updatedAt: string | null;
  status: 'idle' | 'updating' | 'error';
};

export type BigramSnapshot = {
  items: Array<{
    phrase: string;
    count: number;
  }>;
  updatedAt: string | null;
};

export type EventSourceLike = {
  addEventListener(type: string, listener: (event: Event | MessageEvent) => void): void;
  close(): void;
};

export type EventSourceFactory = (url: string) => EventSourceLike;

export type StreamClientHandlers = {
  onOpen: () => void;
  onError: () => void;
  onPost: (post: GenericPost) => void;
  onStats: (stats: ChannelStats) => void;
  onSummary: (summary: SummarySnapshot) => void;
  onBigrams: (snapshot: BigramSnapshot) => void;
  onSystem: (payload: { message: string }) => void;
};

export class FilterStreamClient {
  private readonly createEventSource: EventSourceFactory;
  private currentSource: EventSourceLike | null = null;

  constructor(createEventSource: EventSourceFactory = (url) => new EventSource(url)) {
    this.createEventSource = createEventSource;
  }

  connect(filterTexts: string[], handlers: StreamClientHandlers): void {
    this.disconnect();

    const params = new URLSearchParams();
    for (const filterText of filterTexts) {
      const trimmed = filterText.trim();
      if (trimmed) {
        params.append('filter', trimmed);
      }
    }

    const url = params.size > 0 ? `/events?${params.toString()}` : '/events';
    const source = this.createEventSource(url);
    this.currentSource = source;

    source.addEventListener('open', () => {
      handlers.onOpen();
    });
    source.addEventListener('error', () => {
      handlers.onError();
    });
    source.addEventListener('post', (event) => {
      handlers.onPost(JSON.parse((event as MessageEvent).data) as GenericPost);
    });
    source.addEventListener('stats', (event) => {
      handlers.onStats(JSON.parse((event as MessageEvent).data) as ChannelStats);
    });
    source.addEventListener('summary', (event) => {
      handlers.onSummary(JSON.parse((event as MessageEvent).data) as SummarySnapshot);
    });
    source.addEventListener('bigrams', (event) => {
      handlers.onBigrams(JSON.parse((event as MessageEvent).data) as BigramSnapshot);
    });
    source.addEventListener('system', (event) => {
      handlers.onSystem(JSON.parse((event as MessageEvent).data) as { message: string });
    });
  }

  disconnect(): void {
    if (!this.currentSource) {
      return;
    }

    this.currentSource.close();
    this.currentSource = null;
  }
}

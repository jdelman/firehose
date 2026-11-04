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

export type AuthorUpdate = {
  source: string;
  authorId: string;
  username: string;
};

export type GenericPost = {
  authorId?: string;
  source?: string;
  id: string;
  username?: string;
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
  spotlightPostId?: string;
  comparison?: string;
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
  onAuthor?: (author: AuthorUpdate) => void;
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

  connect(filterTexts: string[], handlers: StreamClientHandlers, sources?: string[]): void {
    this.disconnect();

    const params = new URLSearchParams();
    for (const filterText of filterTexts) {
      const trimmed = filterText.trim();
      if (trimmed) {
        params.append('filter', trimmed);
      }
    }

    for (const source of sources ?? []) params.append('source', source);
    const url = params.size > 0 ? `/events?${params.toString()}` : '/events';
    const source = this.createEventSource(url);
    this.currentSource = source;

    source.addEventListener('open', () => {
      if (this.currentSource !== source) return;
      handlers.onOpen();
    });
    source.addEventListener('error', () => {
      if (this.currentSource !== source) return;
      handlers.onError();
    });
    source.addEventListener('post', (event) => {
      if (this.currentSource !== source) return;
      handlers.onPost(JSON.parse((event as MessageEvent).data) as GenericPost);
    });
    source.addEventListener('author', (event) => {
      if (this.currentSource !== source) return;
      handlers.onAuthor?.(JSON.parse((event as MessageEvent).data) as AuthorUpdate);
    });
    source.addEventListener('stats', (event) => {
      if (this.currentSource !== source) return;
      handlers.onStats(JSON.parse((event as MessageEvent).data) as ChannelStats);
    });
    source.addEventListener('summary', (event) => {
      if (this.currentSource !== source) return;
      handlers.onSummary(JSON.parse((event as MessageEvent).data) as SummarySnapshot);
    });
    source.addEventListener('bigrams', (event) => {
      if (this.currentSource !== source) return;
      handlers.onBigrams(JSON.parse((event as MessageEvent).data) as BigramSnapshot);
    });
    source.addEventListener('system', (event) => {
      if (this.currentSource !== source) return;
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

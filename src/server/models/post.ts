export type AuthorUpdate = {
  source: string;
  authorId: string;
  username: string;
};

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
  source: string;
  channelKey: string;
  authorId: string;
  username?: string;
  profileUrl?: string;
  postUrl?: string;
  text: string;
  facets?: PostFacet[];
  images?: PostImage[];
  createdAt: string;
  language?: string;
  raw?: unknown;
};

export function normalizeFilter(filterText: string): string {
  return filterText.trim().toLowerCase();
}

export function normalizeFilters(filterTexts: string[]): string[] {
  return [...new Set(filterTexts.map(normalizeFilter).filter(Boolean))].sort();
}

export function toChannelKey(filterTexts: string[]): string {
  const normalized = normalizeFilters(filterTexts);
  return normalized.length > 0 ? normalized.join('|') : '__all__';
}

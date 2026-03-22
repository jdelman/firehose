import {
  type BigramSnapshot,
  FilterStreamClient,
  type GenericPost,
  type ChannelStats,
  type SummarySnapshot,
} from './stream-client.js';
import { AudioEngine } from './audio-engine.js';

const MAX_POSTS = 500;
const PIN_TO_BOTTOM_STORAGE_KEY = 'bluesky.pinToBottom';
const THEME_STORAGE_KEY = 'bluesky.theme';
const SOUND_MODE_STORAGE_KEY = 'bluesky.soundMode';
const URL_PATTERN = /https?:\/\/[^\s]+/gi;

const elements = {
  filterForm: document.querySelector<HTMLFormElement>('#filter-form'),
  filterInput: document.querySelector<HTMLInputElement>('#filter-input'),
  filterChips: document.querySelector<HTMLDivElement>('#filter-chips'),
  streamToggleButton: document.querySelector<HTMLButtonElement>('#stream-toggle-button'),
  clearAppButton: document.querySelector<HTMLButtonElement>('#clear-app-button'),
  clearBigramsButton: document.querySelector<HTMLButtonElement>('#clear-bigrams-button'),
  soundMode: document.querySelector<HTMLInputElement>('#sound-mode'),
  themeButton: document.querySelector<HTMLButtonElement>('#theme-button'),
  pinToBottom: document.querySelector<HTMLInputElement>('#pin-to-bottom'),
  posts: document.querySelector<HTMLDivElement>('#posts'),
  connectionState: document.querySelector<HTMLElement>('#connection-state'),
  currentFilter: document.querySelector<HTMLElement>('#current-filter'),
  postsPerSecond: document.querySelector<HTMLElement>('#posts-per-second'),
  totalPosts: document.querySelector<HTMLElement>('#total-posts'),
  subscriberCount: document.querySelector<HTMLElement>('#subscriber-count'),
  summaryAge: document.querySelector<HTMLElement>('#summary-age'),
  summaryStatus: document.querySelector<HTMLElement>('#summary-status'),
  summaryText: document.querySelector<HTMLElement>('#summary-text'),
  bigramsList: document.querySelector<HTMLOListElement>('#bigrams-list'),
  keywordsList: document.querySelector<HTMLOListElement>('#keywords-list'),
  systemMessage: document.querySelector<HTMLElement>('#system-message'),
};

let activeFilters: string[] = [];
let summarySnapshot: SummarySnapshot = {
  text: 'Waiting for the first 10-second window.',
  keywords: {},
  updatedAt: null,
  status: 'idle',
};
let bigramSnapshot: BigramSnapshot = {
  items: [],
  updatedAt: null,
};
let currentPostsPerSecond = 0;
let streamStopped = true;
let streamActive = false;
const streamClient = new FilterStreamClient();
const audioEngine = new AudioEngine();

function assertDom() {
  for (const [name, element] of Object.entries(elements)) {
    if (!element) {
      throw new Error(`Missing required DOM element: ${name}`);
    }
  }
}

function normalizeFilterValue(filterText: string): string {
  return filterText.trim();
}

function normalizeFilterKey(filterText: string): string {
  return normalizeFilterValue(filterText).toLowerCase();
}

function normalizeFilterValues(filterTexts: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const filterText of filterTexts) {
    const trimmed = normalizeFilterValue(filterText);
    const key = normalizeFilterKey(trimmed);
    if (!trimmed || seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(trimmed);
  }

  return normalized;
}

function formatFilterLabel(filterTexts: string[]): string {
  return filterTexts.length > 0 ? filterTexts.join(', ') : 'all';
}

function updateFilterDisplay() {
  elements.currentFilter!.textContent = formatFilterLabel(activeFilters);
  renderFilterChips();
}

function renderFilterChips() {
  const container = elements.filterChips!;
  container.replaceChildren();

  for (const filterText of activeFilters) {
    const chip = document.createElement('span');
    chip.className = 'filter-chip';

    const label = document.createElement('span');
    label.className = 'filter-chip-label';
    label.textContent = filterText;

    const removeButton = document.createElement('button');
    removeButton.className = 'filter-chip-remove';
    removeButton.type = 'button';
    removeButton.setAttribute('aria-label', `Remove filter ${filterText}`);
    removeButton.textContent = 'x';
    removeButton.addEventListener('click', () => {
      removeFilter(filterText);
    });

    chip.append(label, removeButton);
    container.append(chip);
  }
}

function setReadyMessage() {
  setSystemMessage(
    activeFilters.length > 0
      ? 'Ready. Press play to open the filtered stream.'
      : 'Ready. Enter a filter and press play.',
  );
}

function syncActiveFilters(
  filterTexts: string[],
  options: { updateHistory?: boolean } = {},
) {
  activeFilters = normalizeFilterValues(filterTexts);
  updateFilterDisplay();

  if (options.updateHistory !== false) {
    updateUrlForFilters(activeFilters);
  }
}

function connect(filterTexts: string[], options: { updateHistory?: boolean } = {}) {
  streamStopped = false;
  streamActive = true;
  updateStreamToggleButton();
  syncActiveFilters(filterTexts, { updateHistory: options.updateHistory });
  setConnectionState('Connecting');
  setSystemMessage('Opening stream...');

  streamClient.connect(activeFilters, {
    onOpen: () => {
      setConnectionState('Connected');
    },
    onError: () => {
      if (streamStopped) {
        return;
      }

      setConnectionState('Reconnecting');
      setSystemMessage('Stream interrupted. Reconnecting...');
    },
    onPost: (post: GenericPost) => {
      appendPost(post);
    },
    onStats: (stats: ChannelStats) => {
      currentPostsPerSecond = stats.postsPerSecond;
      elements.postsPerSecond!.textContent = stats.postsPerSecond.toFixed(2);
      elements.totalPosts!.textContent = stats.totalPosts.toString();
      elements.subscriberCount!.textContent = stats.subscriberCount.toString();
    },
    onSummary: (summary: SummarySnapshot) => {
      if (isEmptySummarySnapshot(summary) && !isEmptySummarySnapshot(summarySnapshot)) {
        elements.summaryStatus!.textContent = summary.status;
        renderSummaryAge();
        return;
      }

      summarySnapshot = summary;
      elements.summaryStatus!.textContent = summarySnapshot.status;
      elements.summaryText!.textContent = summarySnapshot.text;
      renderKeywords();
      renderSummaryAge();
    },
    onBigrams: (snapshot: BigramSnapshot) => {
      if (isEmptyBigramSnapshot(snapshot) && !isEmptyBigramSnapshot(bigramSnapshot)) {
        return;
      }

      bigramSnapshot = snapshot;
      renderBigrams();
    },
    onSystem: (payload) => {
      setSystemMessage(payload.message);
    },
  });
}

function stopStream(config: { keepPosts?: boolean; message?: string } = {}) {
  streamStopped = true;
  streamActive = false;
  updateStreamToggleButton();
  streamClient.disconnect();
  setConnectionState('Stopped');
  setSystemMessage(config.message ?? 'Stream stopped.');

  if (!config.keepPosts) {
    clearPosts();
  }
}

function applyUrlState() {
  const filtersFromUrl = getFiltersFromUrl();
  elements.filterInput!.value = '';
  syncActiveFilters(filtersFromUrl, { updateHistory: false });

  if (filtersFromUrl.length > 0) {
    connect(filtersFromUrl, { updateHistory: false });
    return;
  }

  stopStream({
    keepPosts: false,
    message: 'Ready. Enter a filter and press play.',
  });
}

function removeFilter(filterText: string) {
  const keyToRemove = normalizeFilterKey(filterText);
  const nextFilters = activeFilters.filter(
    (value) => normalizeFilterKey(value) !== keyToRemove,
  );

  if (streamActive) {
    connect(nextFilters);
  } else {
    syncActiveFilters(nextFilters);
    setReadyMessage();
  }
}

function addFilters(filterTexts: string[]) {
  const nextFilters = normalizeFilterValues([...activeFilters, ...filterTexts]);
  if (nextFilters.length === activeFilters.length) {
    return;
  }

  if (streamActive) {
    connect(nextFilters);
  } else {
    syncActiveFilters(nextFilters);
    setReadyMessage();
  }
}

function updateStreamToggleButton() {
  elements.streamToggleButton!.textContent = streamActive ? 'pause' : 'play';
}

function resetAppState() {
  summarySnapshot = {
    text: 'Waiting for the first 10-second window.',
    keywords: {},
    updatedAt: null,
    status: 'idle',
  };
  bigramSnapshot = {
    items: [],
    updatedAt: null,
  };
  currentPostsPerSecond = 0;
  elements.postsPerSecond!.textContent = '0.00';
  elements.totalPosts!.textContent = '0';
  elements.subscriberCount!.textContent = '0';
  elements.summaryStatus!.textContent = summarySnapshot.status;
  elements.summaryText!.textContent = summarySnapshot.text;
  renderSummaryAge();
  renderBigrams();
  renderKeywords();
  clearPosts();
}

function clearApplication() {
  const shouldKeepStreaming = streamActive;

  elements.filterInput!.value = '';
  syncActiveFilters([]);
  resetAppState();

  if (shouldKeepStreaming) {
    connect([], { updateHistory: false });
    return;
  }

  setReadyMessage();
}

function appendPost(post: GenericPost) {
  const container = elements.posts!;
  const article = document.createElement('article');
  article.className = 'post-card';
  article.append(createPostMeta(post));
  article.append(createPostBody(post));

  const imageGallery = createPostImages(post);
  if (imageGallery) {
    article.append(imageGallery);
  }

  container.append(article);

  while (container.children.length > MAX_POSTS) {
    container.firstElementChild?.remove();
  }

  if (isPinnedToBottom()) {
    container.scrollTop = container.scrollHeight;
  }

  if (isSoundModeEnabled()) {
    void audioEngine.playClick(currentPostsPerSecond);
  }
}

function clearPosts() {
  elements.posts!.replaceChildren();
  if (isPinnedToBottom()) {
    elements.posts!.scrollTop = elements.posts!.scrollHeight;
  }
}

function setConnectionState(text: string) {
  elements.connectionState!.textContent = text;
}

function setSystemMessage(text: string) {
  elements.systemMessage!.textContent = text;
}

function isPinnedToBottom(): boolean {
  return elements.pinToBottom!.checked;
}

function loadPinToBottomPreference(): boolean {
  try {
    const stored = window.localStorage.getItem(PIN_TO_BOTTOM_STORAGE_KEY);
    if (stored === null) {
      return true;
    }

    return stored === 'true';
  } catch {
    return true;
  }
}

function persistPinToBottomPreference(value: boolean) {
  try {
    window.localStorage.setItem(PIN_TO_BOTTOM_STORAGE_KEY, String(value));
  } catch {
    // Ignore storage failures and keep the in-memory setting.
  }
}

function loadThemePreference(): 'light' | 'dark' {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === 'dark'
      ? 'dark'
      : 'light';
  } catch {
    return 'light';
  }
}

function loadSoundModePreference(): boolean {
  try {
    return window.localStorage.getItem(SOUND_MODE_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function persistSoundModePreference(value: boolean) {
  try {
    window.localStorage.setItem(SOUND_MODE_STORAGE_KEY, String(value));
  } catch {
    // Ignore storage failures and keep the in-memory setting.
  }
}

function persistThemePreference(theme: 'light' | 'dark') {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures and keep the in-memory setting.
  }
}

function applyTheme(theme: 'light' | 'dark') {
  document.documentElement.dataset.theme = theme;
  elements.themeButton!.textContent =
    theme === 'dark' ? 'Light mode' : 'Dark mode';
}

function isSoundModeEnabled(): boolean {
  return elements.soundMode!.checked;
}

function getFiltersFromUrl(): string[] {
  const params = new URLSearchParams(window.location.search);
  return normalizeFilterValues(params.getAll('filter'));
}

function updateUrlForFilters(filterTexts: string[]) {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.delete('filter');
  for (const filterText of filterTexts) {
    nextUrl.searchParams.append('filter', filterText);
  }

  if (nextUrl.toString() === window.location.href) {
    return;
  }

  window.history.pushState({}, '', nextUrl);
}

function renderSummaryAge() {
  elements.summaryAge!.textContent = formatAge(summarySnapshot.updatedAt);
}

function isEmptySummarySnapshot(snapshot: SummarySnapshot): boolean {
  return (
    snapshot.updatedAt === null &&
    snapshot.text === 'Waiting for the first 10-second window.' &&
    Object.keys(snapshot.keywords).length === 0
  );
}

function isEmptyBigramSnapshot(snapshot: BigramSnapshot): boolean {
  return snapshot.updatedAt === null && snapshot.items.length === 0;
}

function renderBigrams() {
  const list = elements.bigramsList!;
  list.replaceChildren();

  if (bigramSnapshot.items.length === 0) {
    const item = document.createElement('li');
    item.textContent = 'Waiting for enough text.';
    list.append(item);
    return;
  }

  for (const bigram of bigramSnapshot.items) {
    const item = document.createElement('li');
    item.textContent = `${bigram.phrase} (${bigram.count})`;
    list.append(item);
  }
}

async function clearBigrams() {
  const url = new URL('/reset-bigrams', window.location.origin);
  for (const filterText of activeFilters) {
    url.searchParams.append('filter', filterText);
  }

  const response = await fetch(url, {
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(`clear request failed with ${response.status}`);
  }

  bigramSnapshot = {
    items: [],
    updatedAt: new Date().toISOString(),
  };
  renderBigrams();
}

function renderKeywords() {
  const container = elements.keywordsList!;
  container.replaceChildren();

  const keywordEntries = Object.entries(summarySnapshot.keywords);
  if (keywordEntries.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'keywords-empty';
    empty.textContent = 'Waiting for enough text.';
    container.append(empty);
    return;
  }

  for (const [keyword, relatedTerms] of keywordEntries) {
    const item = document.createElement('li');
    item.className = 'keywords-item';
    const button = document.createElement('button');
    button.className = 'keyword-button';
    button.type = 'button';
    button.textContent = keyword;
    button.addEventListener('click', () => {
      addFilters([keyword, ...relatedTerms]);
    });
    item.append(button);
    container.append(item);
  }
}

function formatAge(updatedAt: string | null): string {
  if (!updatedAt) {
    return 'never';
  }

  const deltaSeconds = Math.max(
    Math.floor((Date.now() - new Date(updatedAt).getTime()) / 1000),
    0,
  );

  if (deltaSeconds < 60) {
    return `${deltaSeconds}s`;
  }

  if (deltaSeconds < 3_600) {
    return `${Math.floor(deltaSeconds / 60)}m`;
  }

  return `${Math.floor(deltaSeconds / 3_600)}h`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function createPostMeta(post: GenericPost): HTMLElement {
  const meta = document.createElement('div');
  meta.className = 'post-meta';

  const userLink = document.createElement('a');
  userLink.className = 'post-link';
  userLink.textContent = post.username;
  userLink.href =
    post.profileUrl ??
    `https://bsky.app/profile/${encodeURIComponent(post.username)}`;
  userLink.target = '_blank';
  userLink.rel = 'noreferrer noopener';

  const timeLink = document.createElement('a');
  timeLink.className = 'post-link';
  timeLink.textContent = formatTimestamp(post.createdAt);
  timeLink.href = post.postUrl ?? userLink.href;
  timeLink.target = '_blank';
  timeLink.rel = 'noreferrer noopener';

  const time = document.createElement('time');
  time.dateTime = post.createdAt;
  time.append(timeLink);

  meta.append(userLink, time);
  return meta;
}

function createPostBody(post: GenericPost): HTMLElement {
  const paragraph = document.createElement('p');
  if (post.facets?.length) {
    appendFacetedText(paragraph, post.text, post.facets, activeFilters);
  } else {
    appendLinkedAndHighlightedText(paragraph, post.text, activeFilters);
  }
  return paragraph;
}

function createPostImages(post: GenericPost): HTMLElement | null {
  if (!post.images?.length) {
    return null;
  }

  const gallery = document.createElement('div');
  gallery.className = 'post-images';

  for (const image of post.images) {
    const link = document.createElement('a');
    link.className = 'post-image-link';
    link.href = image.url;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';

    const element = document.createElement('img');
    element.className = 'post-image';
    element.src = image.url;
    element.alt = image.alt || 'Embedded Bluesky image';
    element.loading = 'lazy';

    link.append(element);
    gallery.append(link);
  }

  return gallery;
}

function appendFacetedText(
  container: HTMLElement,
  text: string,
  facets: GenericPost['facets'],
  filterTexts: string[],
) {
  const sortedFacets = [...(facets ?? [])].sort(
    (left, right) => left.byteStart - right.byteStart,
  );
  let cursor = 0;

  for (const facet of sortedFacets) {
    const start = byteOffsetToCodeUnitIndex(text, facet.byteStart);
    const end = byteOffsetToCodeUnitIndex(text, facet.byteEnd);

    if (start < cursor || end <= start) {
      continue;
    }

    appendLinkedAndHighlightedText(container, text.slice(cursor, start), filterTexts);

    const fragmentText = text.slice(start, end);
    const href = facetToHref(facet);

    if (href) {
      const anchor = document.createElement('a');
      anchor.className = 'post-link';
      anchor.href = href;
      anchor.target = '_blank';
      anchor.rel = 'noreferrer noopener';
      appendHighlightedText(anchor, fragmentText, filterTexts);
      container.append(anchor);
    } else {
      appendHighlightedText(container, fragmentText, filterTexts);
    }

    cursor = end;
  }

  appendLinkedAndHighlightedText(container, text.slice(cursor), filterTexts);
}

function facetToHref(facet: NonNullable<GenericPost['facets']>[number]): string | null {
  if (facet.type === 'link' && facet.uri) {
    return facet.uri;
  }

  if (facet.type === 'mention' && facet.did) {
    return `https://bsky.app/profile/${encodeURIComponent(facet.did)}`;
  }

  if (facet.type === 'tag' && facet.tag) {
    return `https://bsky.app/search?q=${encodeURIComponent(`#${facet.tag}`)}`;
  }

  return null;
}

function byteOffsetToCodeUnitIndex(text: string, targetByteOffset: number): number {
  if (targetByteOffset <= 0) {
    return 0;
  }

  let byteOffset = 0;

  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) {
      return text.length;
    }

    const char = String.fromCodePoint(codePoint);
    const nextByteOffset = byteOffset + new TextEncoder().encode(char).length;
    if (nextByteOffset > targetByteOffset) {
      return index;
    }

    byteOffset = nextByteOffset;
    if (codePoint > 0xffff) {
      index += 1;
    }

    if (byteOffset === targetByteOffset) {
      return codePoint > 0xffff ? index + 1 : index + 1;
    }
  }

  return text.length;
}

function appendLinkedAndHighlightedText(
  container: HTMLElement,
  text: string,
  filterTexts: string[],
) {
  let lastIndex = 0;

  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0];
    const index = match.index ?? 0;

    appendHighlightedText(container, text.slice(lastIndex, index), filterTexts);

    const anchor = document.createElement('a');
    anchor.className = 'post-link';
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noreferrer noopener';
    anchor.textContent = url;
    container.append(anchor);

    lastIndex = index + url.length;
  }

  appendHighlightedText(container, text.slice(lastIndex), filterTexts);
}

function createHighlightPattern(filterTexts: string[]): RegExp | null {
  const patterns = normalizeFilterValues(filterTexts)
    .sort((left, right) => right.length - left.length)
    .map(escapeForRegExp);

  if (patterns.length === 0) {
    return null;
  }

  return new RegExp(patterns.join('|'), 'gi');
}

function appendHighlightedText(
  container: HTMLElement,
  text: string,
  filterTexts: string[],
) {
  if (!text) {
    return;
  }

  const pattern = createHighlightPattern(filterTexts);
  if (!pattern) {
    container.append(document.createTextNode(text));
    return;
  }

  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const value = match[0];

    if (index > cursor) {
      container.append(document.createTextNode(text.slice(cursor, index)));
    }

    const mark = document.createElement('mark');
    mark.className = 'filter-hit';
    mark.textContent = value;
    container.append(mark);
    cursor = index + value.length;
  }

  if (cursor < text.length) {
    container.append(document.createTextNode(text.slice(cursor)));
  }
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function init() {
  assertDom();
  elements.pinToBottom!.checked = loadPinToBottomPreference();
  elements.soundMode!.checked = loadSoundModePreference();
  applyTheme(loadThemePreference());
  updateStreamToggleButton();

  const initialFilters = getFiltersFromUrl();
  syncActiveFilters(initialFilters, { updateHistory: false });
  elements.filterInput!.value = '';
  setConnectionState('Stopped');
  resetAppState();
  setReadyMessage();

  elements.filterForm!.addEventListener('submit', (event) => {
    event.preventDefault();

    const draftFilter = normalizeFilterValue(elements.filterInput!.value);
    elements.filterInput!.value = '';
    if (draftFilter) {
      addFilters([draftFilter]);
      return;
    }
  });
  elements.streamToggleButton!.addEventListener('click', () => {
    if (streamActive) {
      stopStream({ keepPosts: true });
      return;
    }

    connect(activeFilters);
  });
  elements.clearAppButton!.addEventListener('click', () => {
    clearApplication();
  });
  elements.clearBigramsButton!.addEventListener('click', async () => {
    try {
      await clearBigrams();
      setSystemMessage('Bigrams cleared.');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to clear bigrams';
      setSystemMessage(`Unable to clear bigrams: ${message}`);
    }
  });
  elements.themeButton!.addEventListener('click', () => {
    const nextTheme =
      document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme);
    persistThemePreference(nextTheme);
  });
  elements.soundMode!.addEventListener('change', () => {
    const enabled = isSoundModeEnabled();
    persistSoundModePreference(enabled);
    if (enabled) {
      void audioEngine.prime();
    }
  });
  window.addEventListener('popstate', () => {
    applyUrlState();
  });
  document.addEventListener('pointerdown', () => {
    if (isSoundModeEnabled()) {
      void audioEngine.prime();
    }
  });
  elements.pinToBottom!.addEventListener('change', () => {
    const pinned = isPinnedToBottom();
    persistPinToBottomPreference(pinned);

    if (pinned) {
      elements.posts!.scrollTop = elements.posts!.scrollHeight;
    }
  });

  setInterval(renderSummaryAge, 1_000);
  renderBigrams();
  renderKeywords();
  if (initialFilters.length > 0) {
    connect(initialFilters, { updateHistory: false });
  }
}

init();

import {
  type AuthorUpdate,
  type BigramSnapshot,
  FilterStreamClient,
  type GenericPost,
  type ChannelStats,
  type SummarySnapshot,
} from './stream-client.js';
import { AudioEngine, type SoundTheme } from './audio-engine.js';
import { CrazyMode } from './crazy-mode.js';
import { CrazyProgress } from './crazy-progress.js';
import { CrazyRateMeter } from './crazy-rate-meter.js';
import { RenderQueue } from './render-queue.js';
import { SpecialUsernames } from './special-usernames.js';
import { bindButtonActivation } from './button-activation.js';
import { readViewOptions, writeViewOptions, type ViewOptions } from './view-options.js';

const MAX_POSTS = 500;
const RATE_HISTORY_SECONDS = 60;
const SUMMARY_AGE_CYCLE_MS = 10_000;
const PIN_TO_BOTTOM_STORAGE_KEY = 'bluesky.pinToBottom';
const THEME_STORAGE_KEY = 'bluesky.theme';
const SOURCES_STORAGE_KEY = 'bluesky.sources';
const SHOW_IMAGES_STORAGE_KEY = 'bluesky.showImages';
type Theme = SoundTheme;

function parseTheme(value: string | null): Theme {
  return value === 'dark' || value === 'streamserver' ? value : 'light';
}
const SOUND_MODE_STORAGE_KEY = 'bluesky.soundMode';
const MODE_STORAGE_KEY = 'bluesky.mode';
const SOUND_ENABLED_STORAGE_KEY = 'bluesky.soundEnabled';
const CRAZY_MODE_STORAGE_KEY = 'bluesky.crazyMode';
const URL_PATTERN = /https?:\/\/[^\s]+/gi;
const xEnabled = document.documentElement.dataset.enableX === 'true';

const elements = {
  sourceBluesky: document.querySelector<HTMLInputElement>('#source-bluesky'),
  sourceX: document.querySelector<HTMLInputElement>('#source-x'),
  sourceXToggle: document.querySelector<HTMLElement>('#source-x-toggle'),
  xStatus: document.querySelector<HTMLElement>('#x-status'),
  filterForm: document.querySelector<HTMLFormElement>('#filter-form'),
  filterInput: document.querySelector<HTMLInputElement>('#filter-input'),
  filterChips: document.querySelector<HTMLDivElement>('#filter-chips'),
  streamToggleButton: document.querySelector<HTMLButtonElement>('#stream-toggle-button'),
  clearAppButton: document.querySelector<HTMLButtonElement>('#clear-app-button'),
  clearBigramsButton: document.querySelector<HTMLButtonElement>('#clear-bigrams-button'),
  settingsButton: document.querySelector<HTMLButtonElement>('#settings-button'),
  settingsDialog: document.querySelector<HTMLDialogElement>('#settings-dialog'),
  settingsClose: document.querySelector<HTMLButtonElement>('#settings-close'),
  soundToggle: document.querySelector<HTMLInputElement>('#sound-toggle'),
  crazyToggle: document.querySelector<HTMLInputElement>('#crazy-toggle'),
  crazyProgress: document.querySelector<HTMLElement>('#crazy-progress'),
  crazyProgressBar: document.querySelector<HTMLProgressElement>('#crazy-progress-bar'),
  crazyRateMeter: document.querySelector<HTMLElement>('#crazy-rate-meter'),
  crazyRateGauge: document.querySelector<SVGSVGElement>('#crazy-rate-gauge'),
  crazyRateNeedle: document.querySelector<SVGGElement>('#crazy-rate-needle'),
  crazyRateTarget: document.querySelector<SVGTextElement>('#crazy-rate-target'),
  crazyRateLabel: document.querySelector<HTMLElement>('#crazy-rate-label'),
  themeSelect: document.querySelector<HTMLSelectElement>('#theme-select'),
  showImages: document.querySelector<HTMLInputElement>('#show-images'),
  pinToBottom: document.querySelector<HTMLInputElement>('#pin-to-bottom'),
  posts: document.querySelector<HTMLDivElement>('#posts'),
  connectionState: document.querySelector<HTMLElement>('#connection-state'),
  currentFilter: document.querySelector<HTMLElement>('#current-filter'),
  postsPerSecond: document.querySelector<HTMLElement>('#posts-per-second'),
  rateSparkline: document.querySelector<SVGSVGElement>('#rate-sparkline'),
  rateSparklinePath: document.querySelector<SVGPathElement>('#rate-sparkline-path'),
  totalPosts: document.querySelector<HTMLElement>('#total-posts'),
  subscriberCount: document.querySelector<HTMLElement>('#subscriber-count'),
  summaryAge: document.querySelector<HTMLElement>('#summary-age'),
  summaryAgeProgress: document.querySelector<SVGCircleElement>('#summary-age-progress'),
  summaryStatus: document.querySelector<HTMLElement>('#summary-status'),
  summaryText: document.querySelector<HTMLElement>('#summary-text'),
  sourceComparison: document.querySelector<HTMLElement>('#source-comparison'),
  comparisonText: document.querySelector<HTMLElement>('#comparison-text'),
  comparisonStatus: document.querySelector<HTMLElement>('#comparison-status'),
  bigramsList: document.querySelector<HTMLOListElement>('#bigrams-list'),
  keywordsList: document.querySelector<HTMLOListElement>('#keywords-list'),
  specialUsernames: document.querySelector<HTMLElement>('#special-usernames'),
  systemMessage: document.querySelector<HTMLElement>('#system-message'),
};

let activeFilters: string[] = [];
let activeSources: string[] = ['bluesky'];

function restoreSourcesFromUrl() {
  const params = new URL(window.location.href).searchParams;
  const sources = (params.has('source') ? params.getAll('source') : loadSourcesPreference())
    .filter(source => source === 'bluesky' || (source === 'x' && xEnabled));
  activeSources = sources.length ? [...new Set(sources)].sort() : ['bluesky'];
  elements.sourceBluesky!.checked = activeSources.includes('bluesky');
  elements.sourceX!.checked = activeSources.includes('x');
  elements.sourceX!.disabled = !xEnabled;
  elements.sourceXToggle!.hidden = !xEnabled;
  elements.xStatus!.hidden = !activeSources.includes('x');
  renderSourceComparison();
}

function appendSources(params: URLSearchParams) {
  params.delete('source');
  for (const source of activeSources) params.append('source', source);
}
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
let pendingStats: ChannelStats | null = null;
let postFragment: DocumentFragment | null = null;
const authorNames = new Map<string, string>();
const specialUsernames = new SpecialUsernames();
let specialUsernamesDirty = false;
const postImages = new WeakMap<HTMLElement, GenericPost['images']>();
let authorsDirty = false;
const postQueue = new RenderQueue<GenericPost>(renderQueuedPost, commitRenderedPosts, MAX_POSTS);
let rateHistory: Array<{ second: number; rate: number }> = [];
let streamStopped = true;
let streamActive = false;
let initialPlayPrompt = false;
const streamClient = new FilterStreamClient();
const audioEngine = new AudioEngine();
const crazyProgress = new CrazyProgress(elements.crazyProgress!, elements.crazyProgressBar!, () => {
  if (isSoundModeEnabled()) void audioEngine.playProgressComplete().catch(() => {});
});
const crazyRateMeter = new CrazyRateMeter(
  elements.crazyRateMeter!, elements.crazyRateGauge!, elements.crazyRateNeedle!,
  elements.crazyRateTarget!, elements.crazyRateLabel!,
);
const crazyMode = new CrazyMode(elements.posts!, () => streamActive, () => { if (isSoundModeEnabled()) void audioEngine.playSpotlight(); }, () => summarySnapshot.spotlightPostId);

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
    bindButtonActivation(removeButton, () => {
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
  updateStreamToggleButton();

  if (options.updateHistory !== false) {
    updateUrlForFilters(activeFilters);
  }
}

function connect(filterTexts: string[], options: { updateHistory?: boolean } = {}) {
  crazyRateMeter.setRate(0);
  crazyMode.clearOverlay();
  postQueue.clear();
  postFragment = null;
  pendingStats = null;
  rateHistory = [];
  renderRateSparkline();
  renderSourceComparison();
  initialPlayPrompt = false;
  streamStopped = false;
  streamActive = true;
  updateStreamToggleButton();
  syncActiveFilters(filterTexts, { updateHistory: options.updateHistory });
  setConnectionState('Connecting');
  setSystemMessage('Opening stream...');
  elements.xStatus!.hidden = !activeSources.includes('x');
  elements.xStatus!.textContent = activeFilters.length ? 'X connecting…' : 'X waiting for filters';

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
      noteSpecialUsername(post.username, post.source);
      crazyProgress.notePost();
      postQueue.enqueue(post);
    },
    onAuthor: updateAuthor,
    onStats: (stats: ChannelStats) => {
      currentPostsPerSecond = stats.postsPerSecond;
      pendingStats = stats;
    },
    onSummary: (summary: SummarySnapshot) => {
      renderSourceComparison(summary);
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
      if (payload.message.startsWith('X ') || payload.message.startsWith('An X ')) {
        if (!activeSources.includes('x')) return;
        elements.xStatus!.textContent = payload.message;
      }
      setSystemMessage(payload.message);
    },
  }, activeSources);
}

function stopStream(config: { keepPosts?: boolean; message?: string; updateHistory?: boolean } = {}) {
  streamStopped = true;
  streamActive = false;
  crazyRateMeter.setRate(0);
  postQueue.clear();
  postFragment = null;
  pendingStats = null;
  crazyMode.clearOverlay();
  updateStreamToggleButton();
  streamClient.disconnect();
  setConnectionState('Stopped');
  elements.xStatus!.textContent = 'X paused';
  setSystemMessage(config.message ?? 'Stream stopped.');
  if (config.updateHistory !== false) updateUrlForFilters(activeFilters);

  if (!config.keepPosts) {
    clearPosts();
  }
}

function applyUrlState() {
  const previousSources = JSON.stringify(activeSources);
  const previousFilters = JSON.stringify(activeFilters);
  restoreSourcesFromUrl();
  const filtersFromUrl = getFiltersFromUrl();
  const options = readViewOptions(new URLSearchParams(window.location.search), {
    play: filtersFromUrl.length > 0,
    theme: loadThemePreference(),
    ...loadEffectsPreference(),
  });
  applyTheme(options.theme);
  applyEffects(options);
  elements.filterInput!.value = '';
  syncActiveFilters(filtersFromUrl, { updateHistory: false });

  if (options.play) {
    if (!streamActive || previousSources !== JSON.stringify(activeSources) || previousFilters !== JSON.stringify(activeFilters)) {
      connect(filtersFromUrl, { updateHistory: false });
    }
  } else {
    stopStream({ keepPosts: true, updateHistory: false });
    setReadyMessage();
  }
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
  const button = elements.streamToggleButton!;
  const label = streamActive ? 'Pause' : 'Play';
  button.dataset.playing = String(streamActive);
  button.setAttribute('aria-label', label);
  button.title = label;
  elements.streamToggleButton!.classList.toggle(
    'play-prompt',
    initialPlayPrompt && !streamActive && activeFilters.length > 0,
  );
}

function resetAppState() {
  specialUsernames.clear();
  specialUsernamesDirty = false;
  elements.specialUsernames!.textContent = 'No special usernames seen yet.';
  crazyProgress.reset();
  crazyRateMeter.setRate(0);
  renderSourceComparison();
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
  pendingStats = null;
  rateHistory = [];
  renderRateSparkline();
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

function renderQueuedPost(post: GenericPost) {
  const article = document.createElement('article');
  article.className = 'post-card';
  article.dataset.postId = post.id;
  article.append(createPostMeta(post));
  article.append(createPostBody(post));

  postImages.set(article, post.images);
  const imageGallery = createPostImages(post.images);
  if (imageGallery) {
    article.append(imageGallery);
  }

  layoutPost(article);
  postFragment ??= document.createDocumentFragment();
  postFragment.append(article);
}

function commitRenderedPosts() {
  const container = elements.posts!;
  if (!postFragment) return;
  container.append(postFragment);
  postFragment = null;

  while (container.children.length > MAX_POSTS) {
    container.firstElementChild?.remove();
  }

  if (isPinnedToBottom()) {
    container.scrollTop = container.scrollHeight;
  }

  if (isSoundModeEnabled()) {
    void audioEngine.playClick(currentPostsPerSecond, parseTheme(document.documentElement.dataset.theme ?? null));
  }
}

function authorKey(source: string, authorId: string): string {
  return JSON.stringify([source, authorId]);
}

function noteSpecialUsername(username: string | undefined, source: string | undefined) {
  if (specialUsernames.add(username, source)) specialUsernamesDirty = true;
}

function updateAuthor(author: AuthorUpdate) {
  noteSpecialUsername(author.username, author.source);
  const key = authorKey(author.source, author.authorId);
  authorNames.delete(key);
  authorNames.set(key, author.username);
  if (authorNames.size > MAX_POSTS * 2) authorNames.delete(authorNames.keys().next().value!);
  authorsDirty = true;
}

function renderPendingUpdates() {
  if (specialUsernamesDirty) {
    specialUsernamesDirty = false;
    elements.specialUsernames!.replaceChildren(...specialUsernames.entries().flatMap((entry, index) => {
      const link = document.createElement('a');
      link.textContent = entry.username;
      link.href = entry.profileUrl;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      return index ? [document.createTextNode(', '), link] : [link];
    }));
  }
  if (pendingStats) {
    const stats = pendingStats;
    pendingStats = null;
    crazyRateMeter.setRate(stats.postsPerSecond);
    const second = Math.floor(Date.now() / 1_000);
    const latest = rateHistory.at(-1);
    if (latest?.second === second) latest.rate = stats.postsPerSecond;
    else rateHistory.push({ second, rate: stats.postsPerSecond });
    for (const [element, value] of [
      [elements.postsPerSecond!, stats.postsPerSecond.toFixed(2)],
      [elements.totalPosts!, String(stats.totalPosts)],
      [elements.subscriberCount!, String(stats.subscriberCount)],
    ] as const) {
      if (element.textContent !== value) element.textContent = value;
    }
  }
  if (authorsDirty) {
    authorsDirty = false;
    document.querySelectorAll<HTMLAnchorElement>('.post-author').forEach(link => {
      const name = authorNames.get(authorKey(link.dataset.source!, link.dataset.authorId!));
      if (name && link.textContent !== name) {
        link.textContent = name;
        link.hidden = false;
      }
    });
  }
}

function clearPosts() {
  postQueue.clear();
  postFragment = null;
  authorNames.clear();
  authorsDirty = false;
  crazyMode.clearOverlay();
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

function loadSourcesPreference(): string[] {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(SOURCES_STORAGE_KEY) ?? 'null');
    return Array.isArray(saved) ? saved.filter((source): source is string => typeof source === 'string') : ['bluesky'];
  } catch {
    return ['bluesky'];
  }
}

function persistSourcesPreference() {
  try {
    window.localStorage.setItem(SOURCES_STORAGE_KEY, JSON.stringify(activeSources));
  } catch {
    // Ignore storage failures and keep the in-memory setting.
  }
}

function loadShowImagesPreference(): boolean {
  try {
    return window.localStorage.getItem(SHOW_IMAGES_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function updateShowImages() {
  const enabled = elements.showImages!.checked;
  try {
    window.localStorage.setItem(SHOW_IMAGES_STORAGE_KEY, String(enabled));
  } catch {
    // Keep the current setting when storage is unavailable.
  }
  crazyMode.clearOverlay();
  for (const article of Array.from(elements.posts!.children) as HTMLElement[]) {
    article.querySelector('.post-images')?.remove();
    const gallery = createPostImages(postImages.get(article));
    if (gallery) article.append(gallery);
  }
  if (isPinnedToBottom()) elements.posts!.scrollTop = elements.posts!.scrollHeight;
}

function loadThemePreference(): Theme {
  try {
    return parseTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'light';
  }
}

function loadEffectsPreference(): Pick<ViewOptions, 'sound' | 'crazy'> {
  try {
    const params = new URLSearchParams();
    const mode = window.localStorage.getItem(MODE_STORAGE_KEY);
    if (mode) params.set('mode', mode);
    const sound = window.localStorage.getItem(SOUND_ENABLED_STORAGE_KEY);
    const crazy = window.localStorage.getItem(CRAZY_MODE_STORAGE_KEY);
    if (sound !== null) params.set('sound', sound);
    if (crazy !== null) params.set('crazy', crazy);
    return readViewOptions(params, {
      play: false,
      theme: 'light',
      sound: window.localStorage.getItem(SOUND_MODE_STORAGE_KEY) === 'true',
      crazy: false,
    });
  } catch {
    return { sound: false, crazy: false };
  }
}

function persistEffectsPreference() {
  try {
    window.localStorage.setItem(SOUND_ENABLED_STORAGE_KEY, String(elements.soundToggle!.checked));
    window.localStorage.setItem(CRAZY_MODE_STORAGE_KEY, String(elements.crazyToggle!.checked));
  } catch {
    // Ignore storage failures and keep the in-memory setting.
  }
}

function persistThemePreference(theme: Theme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Ignore storage failures and keep the in-memory setting.
  }
}

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  elements.themeSelect!.value = theme;
  document.querySelectorAll<HTMLElement>('.post-card').forEach(layoutPost);
  if (isPinnedToBottom()) elements.posts!.scrollTop = elements.posts!.scrollHeight;
}

function layoutPost(article: HTMLElement) {
  const time = article.querySelector('time')!;
  if (document.documentElement.dataset.theme === 'streamserver') {
    article.querySelector('p')!.after(time);
  } else {
    article.querySelector('.post-meta')!.append(time);
  }
}

function applyEffects(options: Pick<ViewOptions, 'sound' | 'crazy'>) {
  elements.soundToggle!.checked = options.sound;
  elements.crazyToggle!.checked = options.crazy;
  crazyMode.setEnabled(options.crazy);
  crazyProgress.setEnabled(options.crazy);
  crazyRateMeter.setEnabled(options.crazy);
  if (options.sound) {
    void audioEngine.prime();
    if (options.crazy) {
      void audioEngine.primeSpotlight();
      void audioEngine.primeProgressComplete().catch(() => {});
    }
  }
}

function isSoundModeEnabled(): boolean {
  return elements.soundToggle!.checked;
}

function getFiltersFromUrl(): string[] {
  const params = new URLSearchParams(window.location.search);
  return normalizeFilterValues(params.getAll('filter'));
}

function updateUrlForFilters(filterTexts: string[], replace = false) {
  const nextUrl = new URL(window.location.href);
  appendSources(nextUrl.searchParams);
  writeViewOptions(nextUrl.searchParams, {
    play: streamActive,
    theme: parseTheme(document.documentElement.dataset.theme ?? null),
    sound: elements.soundToggle!.checked,
    crazy: elements.crazyToggle!.checked,
  });
  nextUrl.searchParams.delete('filter');
  for (const filterText of filterTexts) {
    nextUrl.searchParams.append('filter', filterText);
  }

  if (nextUrl.toString() === window.location.href) {
    return;
  }

  if (replace) window.history.replaceState({}, '', nextUrl);
  else window.history.pushState({}, '', nextUrl);
}

function renderSourceComparison(summary?: SummarySnapshot) {
  elements.sourceComparison!.hidden = !(activeSources.includes('bluesky') && activeSources.includes('x'));
  elements.comparisonText!.textContent = summary?.comparison ?? 'Waiting for recent posts from both sources.';
  elements.comparisonStatus!.textContent = summary?.comparison && !summary.comparison.startsWith('Waiting for') ? summary.status : 'waiting';
}

function renderSummaryAge() {
  elements.summaryAge!.textContent = formatAge(summarySnapshot.updatedAt);
  const updatedAt = summarySnapshot.updatedAt === null ? NaN : Date.parse(summarySnapshot.updatedAt);
  const progress = Number.isFinite(updatedAt)
    ? Math.min(1, Math.max(0, (Date.now() - updatedAt) / SUMMARY_AGE_CYCLE_MS))
    : 0;
  elements.summaryAgeProgress!.setAttribute('stroke-dashoffset', String(1 - progress));
}

function renderRateSparkline() {
  const now = Math.floor(Date.now() / 1_000);
  rateHistory = rateHistory.filter(sample => sample.second > now - RATE_HISTORY_SECONDS);
  const peak = Math.max(1, ...rateHistory.map(sample => sample.rate));
  let previousSecond: number | undefined;
  const path = rateHistory.map(sample => {
    const x = 71 - (now - sample.second) * 70 / (RATE_HISTORY_SECONDS - 1);
    const y = 19 - sample.rate / peak * 17;
    // Leave gaps when the stream is paused or disconnected.
    const command = previousSecond === sample.second - 1 ? 'L' : 'M';
    previousSecond = sample.second;
    return `${command}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
  elements.rateSparklinePath!.setAttribute('d', path);
  elements.rateSparkline!.setAttribute('aria-label',
    `Posts per second over the last 60 seconds. Peak ${Math.max(0, ...rateHistory.map(sample => sample.rate)).toFixed(2)}.`);
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
  appendSources(url.searchParams);
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
    bindButtonActivation(button, () => {
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
  userLink.className = 'post-link post-author';
  userLink.dataset.source = post.source ?? 'bluesky';
  userLink.dataset.authorId = post.authorId ?? post.username ?? '';
  const username = authorNames.get(authorKey(userLink.dataset.source, userLink.dataset.authorId)) ?? post.username;
  userLink.textContent = username ?? '';
  userLink.hidden = !username;
  userLink.href =
    post.profileUrl ??
    `https://bsky.app/profile/${encodeURIComponent(post.authorId ?? post.username ?? '').replaceAll('%3A', ':')}`;
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

  const sourceLabel = document.createElement('span');
  sourceLabel.className = 'pill post-source';
  sourceLabel.textContent = post.source === 'x' ? 'X' : 'Bluesky';
  meta.append(sourceLabel, userLink, time);
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

function createPostImages(images: GenericPost['images']): HTMLElement | null {
  if (!elements.showImages!.checked || !images?.length) {
    return null;
  }

  const gallery = document.createElement('div');
  gallery.className = 'post-images';

  for (const image of images) {
    const link = document.createElement('a');
    link.className = 'post-image-link';
    link.href = image.url;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';

    const element = document.createElement('img');
    element.className = 'post-image';
    element.src = image.url;
    element.alt = image.alt || 'Embedded post image';
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
      anchor.className = `post-link post-${facet.type}`;
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
    return `https://bsky.app/profile/${encodeURIComponent(facet.did).replaceAll('%3A', ':')}`;
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
  // Yield before and after touch gestures so feed insertion/scrolling cannot
  // compete with the release event. Incoming posts remain in the bounded queue.
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const) {
    document.addEventListener(type, event => {
      if (event.pointerType === 'touch') postQueue.defer(200);
    }, { capture: true, passive: true });
  }
  bindButtonActivation(elements.settingsButton!, () => {
    crazyMode.clearOverlay();
    elements.settingsDialog!.showModal();
  });
  bindButtonActivation(elements.settingsClose!, () => elements.settingsDialog!.close());
  elements.settingsDialog!.addEventListener('click', event => {
    if (event.target !== elements.settingsDialog) return;
    const bounds = elements.settingsDialog!.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      elements.settingsDialog!.close();
    }
  });
  restoreSourcesFromUrl();
  for (const checkbox of [elements.sourceBluesky!, elements.sourceX!]) {
    checkbox.addEventListener('change', () => {
      if (!elements.sourceBluesky!.checked && !elements.sourceX!.checked) {
        checkbox.checked = true;
        setSystemMessage('Select at least one source.');
        return;
      }
      activeSources = [elements.sourceBluesky!.checked ? 'bluesky' : '', xEnabled && elements.sourceX!.checked ? 'x' : ''].filter(Boolean);
      persistSourcesPreference();
      renderSourceComparison();
      elements.xStatus!.hidden = !activeSources.includes('x');
      elements.xStatus!.textContent = 'X ready';
      if (streamActive) connect(activeFilters);
      else { updateUrlForFilters(activeFilters); setReadyMessage(); }
    });
  }
  elements.pinToBottom!.checked = loadPinToBottomPreference();
  elements.showImages!.checked = loadShowImagesPreference();
  elements.showImages!.addEventListener('change', updateShowImages);
  const initialFilters = getFiltersFromUrl();
  const initialOptions = readViewOptions(new URLSearchParams(window.location.search), {
    play: initialFilters.length > 0,
    theme: loadThemePreference(),
    ...loadEffectsPreference(),
  });
  applyEffects(initialOptions);
  applyTheme(initialOptions.theme);
  updateStreamToggleButton();

  initialPlayPrompt = initialFilters.length === 0
    && activeSources.length === 1 && activeSources[0] === 'bluesky'
    && elements.pinToBottom!.checked && !isSoundModeEnabled()
    && document.documentElement.dataset.theme === 'light';
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
  bindButtonActivation(elements.streamToggleButton!, () => {
    if (streamActive) {
      stopStream({ keepPosts: true });
      return;
    }

    connect(activeFilters);
  });
  bindButtonActivation(elements.clearAppButton!, () => {
    clearApplication();
  });
  bindButtonActivation(elements.clearBigramsButton!, async () => {
    try {
      await clearBigrams();
      setSystemMessage('Bigrams cleared.');
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unable to clear bigrams';
      setSystemMessage(`Unable to clear bigrams: ${message}`);
    }
  });
  elements.themeSelect!.addEventListener('change', () => {
    const nextTheme = parseTheme(elements.themeSelect!.value);
    applyTheme(nextTheme);
    persistThemePreference(nextTheme);
    updateUrlForFilters(activeFilters);
  });
  for (const toggle of [elements.soundToggle!, elements.crazyToggle!]) {
    toggle.addEventListener('change', () => {
      applyEffects({ sound: elements.soundToggle!.checked, crazy: elements.crazyToggle!.checked });
      persistEffectsPreference();
      updateUrlForFilters(activeFilters);
    });
  }
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

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') crazyMode.clearOverlay();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) crazyMode.clearOverlay();
  });

  setInterval(renderPendingUpdates, 250);
  setInterval(renderSummaryAge, 250);
  setInterval(renderRateSparkline, 1_000);
  renderBigrams();
  renderKeywords();
  if (initialOptions.play) {
    connect(initialFilters, { updateHistory: false });
  }
  updateUrlForFilters(activeFilters, true);
}

init();

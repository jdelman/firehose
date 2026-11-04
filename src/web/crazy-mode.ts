const SPOTLIGHT_INTERVAL_MS = 15_000;
const SPOTLIGHT_DURATION_MS = 3_000;

export class CrazyMode {
  private interval: ReturnType<typeof setInterval> | null = null;
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private overlay: HTMLElement | null = null;
  private lastPreferredPostId: string | undefined;

  constructor(
    private readonly posts: HTMLElement,
    private readonly isStreaming: () => boolean,
    private readonly onShow: () => void = () => {},
    private readonly preferredPostId: () => string | undefined = () => undefined,
  ) {}

  setEnabled(enabled: boolean): void {
    if (this.interval !== null) clearInterval(this.interval);
    this.interval = null;
    this.clearOverlay();
    if (enabled) this.interval = setInterval(() => this.showPost(), SPOTLIGHT_INTERVAL_MS);
  }

  clearOverlay(): void {
    if (this.fadeTimer !== null) clearTimeout(this.fadeTimer);
    this.fadeTimer = null;
    this.overlay?.remove();
    this.overlay = null;
  }

  private showPost(): void {
    if (!this.isStreaming() || document.hidden) return;
    const posts = this.posts.children;
    if (!posts.length) return;
    this.clearOverlay();
    const preferredId = this.preferredPostId();
    const preferred = preferredId && preferredId !== this.lastPreferredPostId
      ? Array.from(posts).find(post => (post as HTMLElement).dataset.postId === preferredId)
      : undefined;
    if (preferred) this.lastPreferredPostId = preferredId;
    const post = preferred ?? posts[Math.floor(Math.random() * posts.length)]!;
    const overlay = document.createElement('div');
    overlay.className = 'crazy-overlay';
    overlay.append(post.cloneNode(true));
    document.body.append(overlay);
    this.overlay = overlay;
    this.fadeTimer = setTimeout(() => this.clearOverlay(), SPOTLIGHT_DURATION_MS);
    this.onShow();
  }
}

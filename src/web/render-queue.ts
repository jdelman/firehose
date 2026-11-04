const RENDER_INTERVAL_MS = 100;
const MAX_BATCH_SIZE = 20;
const RENDER_BUDGET_MS = 6;

/** Keep the latest feed items and yield between small batches for user input. */
export class RenderQueue<T> {
  private items: T[] = [];
  private deferredUntil = 0;
  private batchSize = MAX_BATCH_SIZE;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly render: (item: T) => void,
    private readonly commit: () => void,
    private readonly capacity = 500,
  ) {}

  enqueue(item: T): void {
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
    this.schedule();
  }

  /** Leave a quiet window for touch handling without losing the latest posts. */
  defer(durationMs: number): void {
    this.deferredUntil = Math.max(this.deferredUntil, performance.now() + durationMs);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.schedule();
  }

  clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.items = [];
  }

  private schedule(): void {
    if (this.timer !== null || !this.items.length) return;
    this.timer = setTimeout(() => this.flush(), Math.max(RENDER_INTERVAL_MS, this.deferredUntil - performance.now()));
  }

  private flush(): void {
    this.timer = null;
    const started = performance.now();
    let count = 0;
    while (this.items.length && count < this.batchSize) {
      this.render(this.items.shift()!);
      count++;
      if (performance.now() - started >= RENDER_BUDGET_MS) break;
    }
    this.commit();
    // Include insertion, pruning and the forced layout from auto-scrolling.
    const elapsed = performance.now() - started;
    this.batchSize = elapsed > RENDER_BUDGET_MS
      ? Math.max(1, Math.floor(count * RENDER_BUDGET_MS / elapsed))
      : Math.min(MAX_BATCH_SIZE, this.batchSize + 1);
    this.schedule();
  }
}

/** Successive bars require 1, 2, 4, 8, ... new posts each. */
export class CrazyProgress {
  private enabled = false;
  private posts = 0;
  private target = 1;

  constructor(
    private readonly container: HTMLElement,
    private readonly bar: HTMLProgressElement,
    private readonly label: HTMLElement,
  ) {
    this.render();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.reset();
  }

  reset(): void {
    this.posts = 0;
    this.target = 1;
    this.render();
  }

  notePost(): void {
    if (!this.enabled) return;
    // Leave a completed bar full until the next post starts the next bar.
    if (this.posts === this.target) {
      this.posts = 0;
      this.target *= 2;
    }
    this.posts++;
    this.render();
  }

  private render(): void {
    this.container.hidden = !this.enabled;
    this.container.dataset.shaking = String(this.enabled && this.posts / this.target >= 0.9);
    this.bar.max = this.target;
    this.bar.value = this.posts;
    this.label.textContent = `${this.posts.toLocaleString('en-US')} / ${this.target.toLocaleString('en-US')} posts`;
  }
}

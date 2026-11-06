/** Successive bars require 1, 2, 4, 8, ... new posts each. */
export class CrazyProgress {
  private enabled = false;
  private posts = 0;
  private target = 1;

  constructor(
    private readonly container: HTMLElement,
    private readonly bar: HTMLProgressElement,
    private readonly onComplete: () => void = () => {},
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
    if (this.posts === this.target) this.onComplete();
  }

  private render(): void {
    this.container.hidden = !this.enabled;
    const fraction = this.posts / this.target;
    const shaking = this.enabled && fraction > 0.25;
    // Cubic acceleration keeps the early motion gentle and ramps up near full.
    const intensity = Math.max(0, (fraction - 0.25) / 0.75) ** 3;
    const frequency = 1 + 11 * intensity;
    this.container.dataset.shaking = String(shaking);
    this.container.style.setProperty('--shake-duration', `${1_000 / frequency}ms`);
    this.container.style.setProperty('--shake-distance', `${1 + 3 * intensity}px`);
    this.container.style.setProperty('--shake-angle', `${0.15 + 0.65 * intensity}deg`);
    this.bar.max = this.target;
    this.bar.value = this.posts;
  }
}

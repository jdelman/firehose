/** A page-lifetime target, centered on a dial spanning zero to twice the target. */
export class CrazyRateMeter {
  readonly target: number;

  constructor(
    private readonly container: HTMLElement,
    private readonly gauge: SVGSVGElement,
    private readonly needle: SVGGElement,
    targetLabel: SVGTextElement,
    private readonly rateLabel: HTMLElement,
    random: () => number = Math.random,
  ) {
    this.target = Math.floor(random() * 20) + 1;
    targetLabel.textContent = String(this.target);
    this.gauge.setAttribute('aria-valuemin', '0');
    this.gauge.setAttribute('aria-valuemax', String(this.target * 2));
    this.setRate(0);
  }

  setEnabled(enabled: boolean): void {
    this.container.hidden = !enabled;
  }

  setRate(value: number): void {
    const rate = Number.isFinite(value) ? Math.max(0, value) : 0;
    const lower = this.target * 0.95;
    const upper = this.target * 1.05;
    const onTarget = rate >= lower && rate <= upper;
    const angle = (Math.min(rate / this.target, 2) - 1) * 75;
    const status = onTarget ? 'On target' : rate < lower ? 'Below target' : 'Above target';
    this.container.dataset.onTarget = String(onTarget);
    this.needle.setAttribute('transform', `rotate(${angle} 150 130)`);
    this.gauge.setAttribute('aria-valuenow', String(Math.min(rate, this.target * 2)));
    this.gauge.setAttribute('aria-valuetext', `${rate.toFixed(2)} posts per second. ${status}. Goal: ${this.target}, within 5%.`);
    this.rateLabel.textContent = `${rate.toFixed(2)} posts/sec · ${status}`;
  }
}

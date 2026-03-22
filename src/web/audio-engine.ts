export class AudioEngine {
  private context: AudioContext | null = null;
  private reverbBuffer: AudioBuffer | null = null;

  async prime(): Promise<void> {
    const context = this.getContext();
    if (!context) {
      return;
    }

    if (context.state === 'suspended') {
      await context.resume();
    }
  }

  async playClick(postsPerSecond = 0): Promise<void> {
    const context = this.getContext();
    if (!context) {
      return;
    }

    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch {
        return;
      }
    }

    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const dryGain = context.createGain();
    const wetGain = context.createGain();
    const convolver = context.createConvolver();
    const startFrequency = this.frequencyForRate(postsPerSecond);
    const endFrequency = Math.max(startFrequency * 1.45, startFrequency + 250);

    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(startFrequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(endFrequency, now + 0.018);

    dryGain.gain.setValueAtTime(0.0001, now);
    dryGain.gain.exponentialRampToValueAtTime(0.04, now + 0.002);
    dryGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.024);

    wetGain.gain.setValueAtTime(0.018, now);
    convolver.buffer = this.getReverbBuffer(context);

    oscillator.connect(dryGain);
    dryGain.connect(context.destination);

    oscillator.connect(convolver);
    convolver.connect(wetGain);
    wetGain.connect(context.destination);

    oscillator.start(now);
    oscillator.stop(now + 0.03);

    oscillator.addEventListener(
      'ended',
      () => {
        oscillator.disconnect();
        dryGain.disconnect();
        convolver.disconnect();
        wetGain.disconnect();
      },
      { once: true },
    );
  }

  private getContext(): AudioContext | null {
    if (typeof window === 'undefined') {
      return null;
    }

    const AudioContextCtor = window.AudioContext;
    if (!AudioContextCtor) {
      return null;
    }

    if (!this.context) {
      this.context = new AudioContextCtor();
    }

    return this.context;
  }

  private frequencyForRate(postsPerSecond: number): number {
    const clampedRate = Math.max(0, Math.min(postsPerSecond, 8));
    return 1600 + clampedRate * 180;
  }

  private getReverbBuffer(context: AudioContext): AudioBuffer {
    if (this.reverbBuffer) {
      return this.reverbBuffer;
    }

    const length = Math.floor(context.sampleRate * 0.09);
    const buffer = context.createBuffer(2, length, context.sampleRate);

    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let index = 0; index < length; index += 1) {
        const decay = Math.pow(1 - index / length, 2.6);
        data[index] = (Math.random() * 2 - 1) * decay * 0.18;
      }
    }

    this.reverbBuffer = buffer;
    return buffer;
  }
}

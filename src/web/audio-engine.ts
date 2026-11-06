export type SoundTheme = 'light' | 'dark' | 'streamserver';

const MIN_SOUND_INTERVAL_SECONDS = 1 / 12;
const PENTATONIC_NOTES = [523.25, 587.33, 659.25, 783.99, 880, 1046.5];

export class AudioEngine {
  private context: AudioContext | null = null;
  private reverbBuffer: AudioBuffer | null = null;
  private output: DynamicsCompressorNode | null = null;
  private reverb: ConvolverNode | null = null;
  private nextSoundAt = -Infinity;
  private melodyStep = 0;
  private clipBuffers = new Map<string, Promise<AudioBuffer | null>>();

  async prime(): Promise<void> {
    const context = this.getContext();
    if (!context) {
      return;
    }

    if (context.state === 'suspended') {
      await context.resume();
    }
  }

  primeSpotlight(): Promise<void> {
    return this.primeClip('/sounds/gunshot.m4a');
  }

  primeProgressComplete(): Promise<void> {
    return this.primeClip('/sounds/faa.m4a');
  }

  private async primeClip(path: string): Promise<void> {
    const context = this.getContext();
    if (!context) return;
    // Start the download before waiting for a user gesture to unlock audio.
    const loaded = this.loadClip(context, path);
    await this.prime();
    await loaded;
  }

  playSpotlight(): Promise<void> {
    return this.playClip('/sounds/gunshot.m4a');
  }

  playProgressComplete(): Promise<void> {
    return this.playClip('/sounds/faa.m4a');
  }

  private async playClip(path: string): Promise<void> {
    const context = this.getContext();
    if (!context) return;
    await this.prime();
    const buffer = await this.loadClip(context, path);
    if (!buffer || context.state !== 'running') return;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.setValueAtTime(0.4, context.currentTime);
    source.connect(gain);
    gain.connect(this.getOutput(context).output);
    source.addEventListener('ended', () => {
      source.disconnect();
      gain.disconnect();
    }, { once: true });
    source.start();
  }

  private loadClip(context: AudioContext, path: string): Promise<AudioBuffer | null> {
    const cached = this.clipBuffers.get(path);
    if (cached) return cached;
    const loaded = (async () => {
      try {
        const response = await fetch(path);
        if (!response.ok) throw new Error('Sound unavailable');
        return await context.decodeAudioData(await response.arrayBuffer());
      } catch {
        this.clipBuffers.delete(path);
        return null;
      }
    })();
    this.clipBuffers.set(path, loaded);
    return loaded;
  }

  async playClick(postsPerSecond = 0, theme: SoundTheme = 'light'): Promise<void> {
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
    // Coalesce bursts rather than queuing sounds that would play after the posts.
    if (now < this.nextSoundAt) return;
    this.nextSoundAt = now + MIN_SOUND_INTERVAL_SECONDS;
    const { output, reverb } = this.getOutput(context);
    const oscillator = context.createOscillator();
    const dryGain = context.createGain();
    const wetGain = context.createGain();
    const rate = Math.max(0, Math.min(postsPerSecond, 8));
    // Transpose by a frequency ratio so the pentatonic intervals stay intact.
    const startFrequency = theme === 'streamserver'
      ? this.nextMusicalFrequency() * 2 ** (rate / 8)
      : theme === 'dark' ? 650 + rate * 70 : this.frequencyForRate(rate);
    const endFrequency = theme === 'streamserver' ? startFrequency
      : theme === 'dark' ? startFrequency * 1.08
      : Math.max(startFrequency * 1.45, startFrequency + 250);
    const decay = theme === 'streamserver' ? 0.085 : theme === 'dark' ? 0.035 : 0.024;
    const filter = theme === 'dark' ? context.createBiquadFilter() : null;
    if (filter) {
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(1_000, now);
      filter.Q.setValueAtTime(0.7, now);
    }

    oscillator.type = theme === 'streamserver' ? 'sine' : theme === 'dark' ? 'triangle' : 'square';
    oscillator.frequency.setValueAtTime(startFrequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(endFrequency, now + 0.018);

    dryGain.gain.setValueAtTime(0.0001, now);
    dryGain.gain.exponentialRampToValueAtTime(0.04, now + 0.002);
    dryGain.gain.exponentialRampToValueAtTime(0.0001, now + decay);

    wetGain.gain.setValueAtTime(theme === 'dark' ? 0.25 : 0.45, now);

    const voice = filter ?? oscillator;
    if (filter) oscillator.connect(filter);
    voice.connect(dryGain);
    dryGain.connect(output);

    // Apply the same smooth envelope to the reverb input to avoid abrupt edges.
    dryGain.connect(wetGain);
    wetGain.connect(reverb);

    oscillator.start(now);
    oscillator.stop(now + decay + 0.006);

    oscillator.addEventListener(
      'ended',
      () => {
        oscillator.disconnect();
        filter?.disconnect();
        dryGain.disconnect();
        wetGain.disconnect();
      },
      { once: true },
    );
  }

  private getOutput(context: AudioContext): { output: DynamicsCompressorNode; reverb: ConvolverNode } {
    if (!this.output) {
      const output = context.createDynamicsCompressor();
      output.threshold.setValueAtTime(-12, context.currentTime);
      output.knee.setValueAtTime(3, context.currentTime);
      output.ratio.setValueAtTime(12, context.currentTime);
      output.attack.setValueAtTime(0.001, context.currentTime);
      output.release.setValueAtTime(0.08, context.currentTime);
      const master = context.createGain();
      master.gain.setValueAtTime(0.8, context.currentTime);
      output.connect(master);
      master.connect(context.destination);
      this.output = output;
    }
    if (!this.reverb) {
      this.reverb = context.createConvolver();
      this.reverb.buffer = this.getReverbBuffer(context);
      this.reverb.connect(this.output);
    }
    return { output: this.output, reverb: this.reverb };
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

  private nextMusicalFrequency(): number {
    const top = PENTATONIC_NOTES.length - 1;
    const index = this.melodyStep <= top ? this.melodyStep : top * 2 - this.melodyStep;
    this.melodyStep = (this.melodyStep + 1) % (top * 2);
    return PENTATONIC_NOTES[index]!;
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

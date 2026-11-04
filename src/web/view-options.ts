import type { SoundTheme } from './audio-engine.js';

export type Mode = 'off' | 'sound' | 'crazy';
export type ViewOptions = { play: boolean; theme: SoundTheme; mode: Mode };

export function readViewOptions(params: URLSearchParams, defaults: ViewOptions): ViewOptions {
  const theme = params.get('theme');
  const mode = params.get('mode');
  const play = params.get('play');
  return {
    play: play === 'true' ? true : play === 'false' ? false : defaults.play,
    theme: theme === 'light' || theme === 'dark' || theme === 'streamserver' ? theme : defaults.theme,
    mode: mode === 'off' || mode === 'sound' || mode === 'crazy' ? mode : defaults.mode,
  };
}

export function writeViewOptions(params: URLSearchParams, options: ViewOptions): void {
  params.set('play', String(options.play));
  params.set('theme', options.theme);
  params.set('mode', options.mode);
}

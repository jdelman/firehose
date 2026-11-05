import type { SoundTheme } from './audio-engine.js';

export type ViewOptions = { play: boolean; theme: SoundTheme; sound: boolean; crazy: boolean };

export function readViewOptions(params: URLSearchParams, defaults: ViewOptions): ViewOptions {
  const theme = params.get('theme');
  // Preserve links made before sound and Crazy mode became independent.
  const mode = params.get('mode');
  const legacyMode = mode === 'off' || mode === 'sound' || mode === 'crazy';
  return {
    play: readBoolean(params.get('play'), defaults.play),
    theme: theme === 'light' || theme === 'dark' || theme === 'streamserver' ? theme : defaults.theme,
    sound: readBoolean(params.get('sound'), legacyMode ? mode !== 'off' : defaults.sound),
    crazy: readBoolean(params.get('crazy'), legacyMode ? mode === 'crazy' : defaults.crazy),
  };
}

function readBoolean(value: string | null, fallback: boolean): boolean {
  return value === 'true' ? true : value === 'false' ? false : fallback;
}

export function writeViewOptions(params: URLSearchParams, options: ViewOptions): void {
  params.set('play', String(options.play));
  params.set('theme', options.theme);
  params.set('sound', String(options.sound));
  params.set('crazy', String(options.crazy));
  params.delete('mode');
}

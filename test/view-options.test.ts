import { describe, expect, test } from 'bun:test';
import { readViewOptions, writeViewOptions, type ViewOptions } from '../src/web/view-options.ts';

const defaults: ViewOptions = { play: false, theme: 'light', mode: 'off' };

describe('shared view options', () => {
  test('URL settings override all saved defaults, including explicit pause and sound off', () => {
    expect(readViewOptions(new URLSearchParams('play=false&theme=light&mode=off'), {
      play: true, theme: 'dark', mode: 'crazy',
    })).toEqual(defaults);
    expect(readViewOptions(new URLSearchParams('play=true&theme=streamserver&mode=crazy'), defaults)).toEqual({
      play: true, theme: 'streamserver', mode: 'crazy',
    });
  });

  test('missing or invalid options preserve the defaults', () => {
    const saved: ViewOptions = { play: true, theme: 'dark', mode: 'sound' };
    expect(readViewOptions(new URLSearchParams(), saved)).toEqual(saved);
    expect(readViewOptions(new URLSearchParams('play=maybe&theme=unknown&mode=unknown'), saved)).toEqual(saved);
  });

  test('round trips playback, all themes, and all modes without disturbing filters or sources', () => {
    for (const play of [true, false]) {
      for (const theme of ['light', 'dark', 'streamserver'] as const) {
        for (const mode of ['off', 'sound', 'crazy'] as const) {
          const params = new URLSearchParams('filter=cats&filter=dogs&source=bluesky&source=x&other=keep');
          const options = { play, theme, mode };
          writeViewOptions(params, options);
          expect(readViewOptions(params, defaults)).toEqual(options);
          expect(params.getAll('filter')).toEqual(['cats', 'dogs']);
          expect(params.getAll('source')).toEqual(['bluesky', 'x']);
          expect(params.get('other')).toBe('keep');
          writeViewOptions(params, options);
          expect(params.getAll('play')).toHaveLength(1);
          expect(params.getAll('theme')).toHaveLength(1);
          expect(params.getAll('mode')).toHaveLength(1);
        }
      }
    }
  });
});

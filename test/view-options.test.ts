import { describe, expect, test } from 'bun:test';
import { readViewOptions, writeViewOptions, type ViewOptions } from '../src/web/view-options.ts';

const defaults: ViewOptions = { play: false, theme: 'light', sound: false, crazy: false };

describe('shared view options', () => {
  test('URL settings override all saved defaults, including explicit off settings', () => {
    expect(readViewOptions(new URLSearchParams('play=false&theme=light&sound=false&crazy=false'), {
      play: true, theme: 'dark', sound: true, crazy: true,
    })).toEqual(defaults);
    expect(readViewOptions(new URLSearchParams('play=true&theme=streamserver&sound=false&crazy=true'), defaults)).toEqual({
      play: true, theme: 'streamserver', sound: false, crazy: true,
    });
  });

  test('missing or invalid options preserve the defaults independently', () => {
    const saved: ViewOptions = { play: true, theme: 'dark', sound: true, crazy: false };
    expect(readViewOptions(new URLSearchParams(), saved)).toEqual(saved);
    expect(readViewOptions(new URLSearchParams('play=maybe&theme=unknown&sound=unknown&crazy=unknown&mode=unknown'), saved)).toEqual(saved);
    expect(readViewOptions(new URLSearchParams('crazy=true'), saved)).toEqual({ ...saved, crazy: true });
    expect(readViewOptions(new URLSearchParams('sound=false'), saved)).toEqual({ ...saved, sound: false });
  });

  test('preserves legacy mode links while allowing independent overrides', () => {
    const enabled = { ...defaults, sound: true, crazy: true };
    expect(readViewOptions(new URLSearchParams('mode=off'), enabled)).toEqual(defaults);
    expect(readViewOptions(new URLSearchParams('mode=sound'), enabled)).toEqual({ ...defaults, sound: true });
    expect(readViewOptions(new URLSearchParams('mode=crazy'), defaults)).toEqual(enabled);
    expect(readViewOptions(new URLSearchParams('mode=crazy&sound=false'), defaults)).toEqual({ ...defaults, crazy: true });
    expect(readViewOptions(new URLSearchParams('mode=crazy&crazy=false'), defaults)).toEqual({ ...defaults, sound: true });
  });

  test('round trips playback, all themes, and independent toggles without disturbing filters or sources', () => {
    for (const play of [true, false]) {
      for (const theme of ['light', 'dark', 'streamserver'] as const) {
        for (const sound of [true, false]) {
          for (const crazy of [true, false]) {
            const params = new URLSearchParams('filter=cats&filter=dogs&source=bluesky&source=x&other=keep&mode=crazy');
            const options = { play, theme, sound, crazy };
            writeViewOptions(params, options);
            expect(readViewOptions(params, defaults)).toEqual(options);
            expect(params.getAll('filter')).toEqual(['cats', 'dogs']);
            expect(params.getAll('source')).toEqual(['bluesky', 'x']);
            expect(params.get('other')).toBe('keep');
            expect(params.has('mode')).toBe(false);
            writeViewOptions(params, options);
            for (const key of ['play', 'theme', 'sound', 'crazy']) {
              expect(params.getAll(key)).toHaveLength(1);
            }
          }
        }
      }
    }
  });
});

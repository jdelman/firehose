import { describe, expect, test } from 'bun:test';
import { SpecialUsernames } from '../src/web/special-usernames.ts';

describe('Special usernames', () => {
  test('excludes default Bluesky suffixes and empty usernames, preserving custom handles', () => {
    const names = new SpecialUsernames();
    for (const username of [undefined, '', '  ', 'alice.bsky.social', 'BOB.BSKY.SOCIAL']) {
      expect(names.add(username)).toBe(false);
    }
    expect(names.add(' alice.example.com ')).toBe(true);
    expect(names.add('bsky.social.example')).toBe(true);
    expect(names.add('x_username')).toBe(true);
    expect(names.toString()).toBe('alice.example.com, bsky.social.example, x_username');
  });

  test('includes later-resolved names once, ignoring case and repeated posts', () => {
    const names = new SpecialUsernames();
    expect(names.add(undefined)).toBe(false);
    expect(names.toString()).toBe('');
    expect(names.add('Alice.Example')).toBe(true);
    expect(names.add('Alice.Example')).toBe(false);
    expect(names.add('alice.example')).toBe(false);
    expect(names.toString()).toBe('Alice.Example');
  });

  test('retains all seen usernames beyond the visible feed limit and can be cleared', () => {
    const names = new SpecialUsernames();
    const expected = Array.from({ length: 1_100 }, (_, index) => `user${index}.example`);
    for (const name of expected) names.add(name);
    expect(names.toString()).toBe(expected.join(', '));
    names.clear();
    expect(names.toString()).toBe('');
    expect(names.add(expected[0])).toBe(true);
  });
});

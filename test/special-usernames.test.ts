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
    expect(names.toString()).toBe('x_username, bsky.social.example, alice.example.com');
  });

  test('moves repeated usernames to the front without duplicates, ignoring case', () => {
    const names = new SpecialUsernames();
    expect(names.add(undefined)).toBe(false);
    expect(names.toString()).toBe('');
    names.add('Alice.Example');
    names.add('bob.example');
    expect(names.toString()).toBe('bob.example, Alice.Example');
    expect(names.add('Alice.Example')).toBe(true);
    expect(names.toString()).toBe('Alice.Example, bob.example');
    expect(names.add('alice.example')).toBe(true);
    expect(names.toString()).toBe('alice.example, bob.example');
  });

  test('retains only the latest 15 usernames, evicting the least recently seen', () => {
    const names = new SpecialUsernames();
    const seen = Array.from({ length: 16 }, (_, index) => `user${index}.example`);
    for (const name of seen.slice(0, 15)) names.add(name);
    names.add(seen[0]); // Refresh the oldest name before adding a new one.
    names.add(seen[15]);
    expect(names.toString()).toBe([seen[15], seen[0], ...seen.slice(2, 15).reverse()].join(', '));
    expect(names.add('ignored.bsky.social')).toBe(false);
    expect(names.toString().split(', ')).toHaveLength(15);
    names.add(seen[1]); // An evicted username can return as the newest.
    expect(names.toString()).toBe([seen[1], seen[15], seen[0], ...seen.slice(3, 15).reverse()].join(', '));
  });

  test('links usernames to the correct platform and keeps identical cross-platform handles separate', () => {
    const names = new SpecialUsernames();
    names.add('alice.example');
    names.add('alice.example', 'x');
    names.add('name/with?characters', 'x');
    expect(names.entries()).toEqual([
      { username: 'name/with?characters', profileUrl: 'https://x.com/name%2Fwith%3Fcharacters' },
      { username: 'alice.example', profileUrl: 'https://x.com/alice.example' },
      { username: 'alice.example', profileUrl: 'https://bsky.app/profile/alice.example' },
    ]);
    names.add('alice.example');
    expect(names.entries()[0]).toEqual({ username: 'alice.example', profileUrl: 'https://bsky.app/profile/alice.example' });
  });

  test('clears the list and accepts previously seen usernames again', () => {
    const names = new SpecialUsernames();
    names.add('alice.example');
    names.clear();
    expect(names.toString()).toBe('');
    expect(names.add('alice.example')).toBe(true);
    expect(names.toString()).toBe('alice.example');
  });
});

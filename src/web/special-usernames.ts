/** Keep the 15 most recently seen distinct non-default usernames, newest first. */
export class SpecialUsernames {
  private readonly usernames = new Map<string, { username: string; profileUrl: string }>();

  add(value: string | undefined, source = 'bluesky'): boolean {
    const username = value?.trim();
    if (!username) return false;
    if (username.toLowerCase().endsWith('.bsky.social')) return false;
    const platform = source === 'x' ? 'x' : 'bluesky';
    const key = `${platform}:${username.toLowerCase()}`;
    this.usernames.delete(key);
    this.usernames.set(key, {
      username,
      profileUrl: platform === 'x'
        ? `https://x.com/${encodeURIComponent(username)}`
        : `https://bsky.app/profile/${encodeURIComponent(username)}`,
    });
    if (this.usernames.size > 15) {
      this.usernames.delete(this.usernames.keys().next().value!);
    }
    return true;
  }

  clear(): void {
    this.usernames.clear();
  }

  entries(): Array<{ username: string; profileUrl: string }> {
    return [...this.usernames.values()].reverse();
  }

  toString(): string {
    return this.entries().map(entry => entry.username).join(', ');
  }
}

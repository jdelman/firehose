/** Keep the 15 most recently seen distinct non-default usernames, newest first. */
export class SpecialUsernames {
  private readonly usernames = new Map<string, string>();

  add(value: string | undefined): boolean {
    const username = value?.trim();
    if (!username) return false;
    const key = username.toLowerCase();
    if (key.endsWith('.bsky.social')) return false;
    this.usernames.delete(key);
    this.usernames.set(key, username);
    if (this.usernames.size > 15) {
      this.usernames.delete(this.usernames.keys().next().value!);
    }
    return true;
  }

  clear(): void {
    this.usernames.clear();
  }

  toString(): string {
    return [...this.usernames.values()].reverse().join(', ');
  }
}

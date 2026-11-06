/** Keep all distinct non-default usernames seen since the application was cleared. */
export class SpecialUsernames {
  private readonly usernames = new Map<string, string>();

  add(value: string | undefined): boolean {
    const username = value?.trim();
    if (!username) return false;
    const key = username.toLowerCase();
    if (key.endsWith('.bsky.social') || this.usernames.has(key)) return false;
    this.usernames.set(key, username);
    return true;
  }

  clear(): void {
    this.usernames.clear();
  }

  toString(): string {
    return [...this.usernames.values()].join(', ');
  }
}

/**
 * Office room patterns: shell-style globs over tmux session names, for example
 * `emperor-*`. `*` matches any run of characters; everything else is literal.
 * The server reads them from PIXEL_AGENTS_OFFICE_ROOMS, separated by commas or
 * whitespace.
 */
export function parseRoomPatterns(raw: string | undefined): string[] {
  return (raw ?? '').split(/[\s,]+/).filter(Boolean);
}

export function matchesRoomPattern(patterns: readonly string[], session: string): boolean {
  return patterns.some((pattern) => {
    const body = pattern
      .split('*')
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${body}$`).test(session);
  });
}

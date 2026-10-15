import type { OfficeRoom } from './messages.js';

/**
 * Office rooms from PIXEL_AGENTS_OFFICE_ROOMS.
 *
 * Entries are separated by `;`. Empty entries are ignored. `name=glob[,glob...]`
 * is a room called `name`. An entry without `=` is one room whose name is that
 * text. Globs are split on commas or whitespace. Name and globs are trimmed.
 * An entry with an empty name or no globs is dropped. `*` matches any run of
 * characters; everything else is literal.
 */
export function parseRoomConfig(raw: string | undefined): OfficeRoom[] {
  const rooms: OfficeRoom[] = [];
  for (const entry of (raw ?? '').split(';')) {
    const text = entry.trim();
    if (!text) continue;
    const eq = text.indexOf('=');
    const name = (eq === -1 ? text : text.slice(0, eq)).trim();
    const patterns = (eq === -1 ? text : text.slice(eq + 1)).split(/[\s,]+/).filter(Boolean);
    if (!name || patterns.length === 0) continue;
    rooms.push({ name, patterns });
  }
  return rooms;
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

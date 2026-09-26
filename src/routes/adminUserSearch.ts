/**
 * Escape LIKE metacharacters in a user-supplied search term.
 *
 * The admin user search wraps the term in `%...%` and matches with ILIKE, so
 * an unescaped `%` from the search box would match every row in the table
 * (and `_` would match any single character). PostgreSQL's LIKE uses backslash
 * as its default escape character, so prefixing the three metacharacters is
 * sufficient and needs no ESCAPE clause.
 *
 * Pure and dependency-free so it is directly unit testable.
 */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (char) => `\\${char}`);
}

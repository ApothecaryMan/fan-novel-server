/**
 * Query-parameter and path-parameter validation for the admin routes.
 *
 * Why this exists: these values are passed to Postgres as typed parameters. A
 * non-numeric `?limit=2.5` reaches the driver as a bigint and fails with
 * SQLSTATE 22P02, and a malformed `:id` fails the uuid cast the same way. The
 * route's catch block treats any thrown error as a database outage and calls
 * `noteDbFailure()`, which makes `isDbAvailable()` false for 30 seconds — so
 * one malformed query string from an authenticated admin degrades every
 * database-backed route in the API, including login. Validating before the
 * query keeps client input errors out of that path entirely.
 *
 * Pure and dependency-free so it is directly unit testable.
 */

/** Postgres bigint range, and the widest page/limit this API will accept. */
const MAX_INT = Number.MAX_SAFE_INTEGER;

/**
 * Parse a bounded integer query parameter.
 *
 * Returns `fallback` for absent, empty, and non-numeric values so existing
 * callers keep their defaults, but returns null for a *present* value that is
 * not a whole number — that is a client error, not a missing parameter, and it
 * must not be silently coerced.
 */
export function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  // Number() accepts '', '  ', '0x10', 'Infinity' and '1e3'; only an explicit
  // finiteness and integrality check is trustworthy here.
  if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
  if (value > MAX_INT || value < -MAX_INT) return null;
  return Math.min(max, Math.max(min, value));
}

/**
 * True for a canonical lowercase-or-uppercase UUID. Deliberately strict: the
 * admin routes address rows by primary key, so a malformed id is a client bug
 * worth a 400 rather than a cast failure deeper in the driver.
 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

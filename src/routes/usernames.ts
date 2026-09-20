// Username ownership: canonical handle rules + pure suggestion generator.
// This module performs zero I/O. Database probing is injected by callers
// via the `isTaken` callback (single-row exact-match existence check).
export const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
export const MAX_SUGGESTIONS = 3;
export const MAX_PROBES = 20;

/** Trim and accept only values already matching USERNAME_RE. Never repair. */
export function normalizeUsernameCandidate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return USERNAME_RE.test(value) ? value : null;
}

function candidateFor(base: string, n: number): string {
  const suffix = `_${n}`;
  const truncated = base.slice(0, 20 - suffix.length);
  return `${truncated}${suffix}`;
}

/**
 * Deterministic suggestions for a taken base: base_1, base_2, ... with
 * 20-char truncation. Collects up to MAX_SUGGESTIONS free candidates,
 * stopping after MAX_PROBES probes. Invalid base yields [] with zero probes.
 */
export async function suggestUsernames(
  base: string,
  isTaken: (candidate: string) => Promise<boolean>,
): Promise<string[]> {
  if (!USERNAME_RE.test(base)) return [];
  const out: string[] = [];
  for (let n = 1; n <= MAX_PROBES && out.length < MAX_SUGGESTIONS; n++) {
    const candidate = candidateFor(base, n);
    if (!USERNAME_RE.test(candidate)) continue;
    if (!(await isTaken(candidate))) out.push(candidate);
  }
  return out;
}

/** Carrier for username-taken 409s so HTTP layers can render suggestions. */
export class UsernameTakenError extends Error {
  suggestions: string[];
  constructor(suggestions: string[] = []) {
    super('اسم المستخدم محجوز بالفعل');
    this.name = 'UsernameTakenError';
    this.suggestions = suggestions;
  }
}

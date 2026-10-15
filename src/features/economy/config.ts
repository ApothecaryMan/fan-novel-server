export const ECONOMY_CURRENCIES = ['free', 'pro'] as const;
export type EconomyCurrency = (typeof ECONOMY_CURRENCIES)[number];

export const REWARD_SOURCES = ['reading', 'daily_login', 'achievement', 'admin', 'pro_monthly', 'iap'] as const;
export type RewardSource = (typeof REWARD_SOURCES)[number];

const CAPPED_SOURCES: ReadonlySet<string> = new Set(['reading', 'daily_login']);
export function isCappedSource(source: string): boolean {
  return CAPPED_SOURCES.has(source);
}

export const DAILY_REWARD_CAP: Record<EconomyCurrency, number> = { free: 500, pro: 0 };

export const PRO_DISCOUNT_PERCENT = 10;
export const PRO_POINTS_MULTIPLIER = 2;
export const PRO_MONTHLY_GRANT: Record<EconomyCurrency, number> = { free: 300, pro: 0 };
export const ADMIN_GRANT_MAX = 1000000;

export function keyFor(source: RewardSource, parts: string): string {
  return `${source}:${parts}`;
}

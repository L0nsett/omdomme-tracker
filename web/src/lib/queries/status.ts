/** Status page logic as pure functions: quota left and run summaries. */
import {
  QUOTA_LIMITS,
  SOURCE_LABELS,
  SOURCE_TYPES,
  type QuotaUsage,
  type Run,
  type RunStats,
  type WebSearchProvider,
} from "@/lib/types";

export const PROVIDERS: readonly WebSearchProvider[] = ["tavily", "exa", "serper"];
export const PROVIDER_LABELS: Record<WebSearchProvider, string> = {
  tavily: "Tavily",
  exa: "Exa",
  serper: "Serper",
};

export interface QuotaRemaining {
  provider: WebSearchProvider;
  label: string;
  used: number;
  limit: number;
  remaining: number;
  /** 0..1, capped at 1. */
  usedShare: number;
  unit: string;
  lifetime: boolean;
  /** Monthly quotas reset on the 1st (UTC); null for lifetime quotas. */
  resetsOn: string | null;
}

/** First day of the month containing `now`, YYYY-MM-DD (UTC) — matches quota_usage.month. */
export function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

function nextMonthKey(now: Date): string {
  return monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
}

/**
 * Remaining free quota per provider. Monthly providers count only the current
 * month's row; lifetime providers (Serper) sum every month.
 */
export function quotaRemaining(usage: readonly QuotaUsage[], now: Date = new Date()): QuotaRemaining[] {
  const month = monthKey(now);
  return PROVIDERS.map((provider) => {
    const { limit, unit, lifetime } = QUOTA_LIMITS[provider];
    const used = usage
      .filter((u) => u.provider === provider && (lifetime || String(u.month).slice(0, 10) === month))
      // Postgres numeric may arrive as a string.
      .reduce((sum, u) => sum + Number(u.credits_used || 0), 0);
    const rounded = Math.round(used * 100) / 100;
    return {
      provider,
      label: PROVIDER_LABELS[provider],
      used: rounded,
      limit,
      remaining: Math.max(0, Math.round((limit - rounded) * 100) / 100),
      usedShare: limit > 0 ? Math.min(1, rounded / limit) : 1,
      unit,
      lifetime,
      resetsOn: lifetime ? null : nextMonthKey(now),
    };
  });
}

/** Amount in the provider's unit, e.g. "$9.50" for Exa, "588" for Tavily. */
export function formatQuotaAmount(provider: WebSearchProvider, n: number): string {
  if (provider === "exa") return `$${n.toFixed(2)}`;
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n);
}

/** Newest first. */
export function sortRuns(runs: readonly Run[]): Run[] {
  return [...runs].sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
}

/** "84 fetched · 6 matched · 3 inserted" (only counters that are present). */
export function summarizeStats(stats: RunStats | null | undefined): string {
  if (!stats) return "—";
  const parts: string[] = [];
  for (const key of ["fetched", "matched", "inserted"] as const) {
    const v = stats[key];
    if (typeof v === "number") parts.push(`${v} ${key}`);
  }
  return parts.length ? parts.join(" · ") : "—";
}

/** Per-source notes, e.g. [{label: "Web", value: "skipped: not due"}]. */
export function perSourceStats(stats: RunStats | null | undefined): { label: string; value: string }[] {
  const per = stats?.per_source;
  if (!per) return [];
  return SOURCE_TYPES.filter((s) => per[s] !== undefined).map((s) => ({
    label: SOURCE_LABELS[s],
    value: String(per[s]),
  }));
}

export interface RunOverview {
  latest: Run | null;
  lastSuccess: Run | null;
  failedCount: number;
}

export function runOverview(runs: readonly Run[]): RunOverview {
  const sorted = sortRuns(runs);
  return {
    latest: sorted[0] ?? null,
    lastSuccess: sorted.find((r) => r.status === "success") ?? null,
    failedCount: sorted.filter((r) => r.status === "failed").length,
  };
}

/** Analytics aggregations as pure functions over Mention arrays. */
import { SOURCE_LABELS, SOURCE_TYPES, type Mention, type SourceType } from "@/lib/types";
import { compareChronological } from "./feed";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** Longest range the weekly chart draws; older weeks are left out. */
export const MAX_WEEKS = 104;

export interface WeekBucket {
  /** Monday of the week, YYYY-MM-DD (UTC). */
  weekStart: string;
  count: number;
}

/** Monday 00:00 UTC of the week containing `t` (ms). */
export function startOfWeekUtc(t: number): number {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY_MS;
}

function toDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Mentions per ISO week (Monday start, UTC), with empty weeks filled in so the
 * chart shows gaps. The range runs from `from` (or the oldest mention) to `to`
 * (or `now`), capped at the latest MAX_WEEKS weeks. Undated mentions are skipped;
 * use `undatedCount` to report them.
 */
export function weeklyBuckets(
  mentions: readonly Mention[],
  opts: { from?: string | null; to?: string | null; now?: Date } = {},
): WeekBucket[] {
  const times = mentions
    .map((m) => (m.published_at ? new Date(m.published_at).getTime() : NaN))
    .filter((t) => !Number.isNaN(t));
  const nowMs = (opts.now ?? new Date()).getTime();
  const endMs = opts.to ? new Date(`${opts.to}T00:00:00Z`).getTime() : Math.max(nowMs, ...times);
  const startMs = opts.from ? new Date(`${opts.from}T00:00:00Z`).getTime() : times.length ? Math.min(...times) : endMs;

  const lastWeek = startOfWeekUtc(endMs);
  const firstWeek = Math.max(startOfWeekUtc(Math.min(startMs, endMs)), lastWeek - (MAX_WEEKS - 1) * WEEK_MS);

  const counts = new Map<number, number>();
  for (const t of times) {
    const w = startOfWeekUtc(t);
    if (w < firstWeek || w > lastWeek) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const buckets: WeekBucket[] = [];
  for (let w = firstWeek; w <= lastWeek; w += WEEK_MS) {
    buckets.push({ weekStart: toDay(w), count: counts.get(w) ?? 0 });
  }
  return buckets;
}

export function undatedCount(mentions: readonly Mention[]): number {
  return mentions.filter((m) => !m.published_at).length;
}

export interface SourceShare {
  source: SourceType;
  label: string;
  count: number;
  /** 0..1 of all given mentions. */
  share: number;
}

/** Count per source type, in SOURCE_TYPES order, including sources with 0. */
export function sourceDistribution(mentions: readonly Mention[]): SourceShare[] {
  const total = mentions.length;
  return SOURCE_TYPES.map((source) => {
    const count = mentions.filter((m) => m.source_type === source).length;
    return { source, label: SOURCE_LABELS[source], count, share: total ? count / total : 0 };
  });
}

export interface NameCount {
  name: string;
  count: number;
}

/** Most frequent publishers / subreddits. */
export function topSourceNames(mentions: readonly Mention[], n = 5): NameCount[] {
  const counts = new Map<string, number>();
  for (const m of mentions) counts.set(m.source_name, (counts.get(m.source_name) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, n);
}

/** Highest reach first, hidden ("Not relevant") mentions excluded. */
export function topByReach(mentions: readonly Mention[], n = 5): Mention[] {
  return mentions
    .filter((m) => !m.hidden)
    .sort((a, b) => b.reach_score - a.reach_score || compareChronological(a, b))
    .slice(0, n);
}

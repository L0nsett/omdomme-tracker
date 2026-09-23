import { describe, expect, it } from "vitest";
import { FIXTURE_NOW, fixtureQuotaUsage, fixtureRuns, reluMentions } from "@/lib/fixtures";
import {
  MAX_WEEKS,
  sourceDistribution,
  startOfWeekUtc,
  topByReach,
  topSourceNames,
  undatedCount,
  weeklyBuckets,
} from "@/lib/queries/analytics";
import { filterMentions } from "@/lib/queries/feed";
import {
  formatQuotaAmount,
  monthKey,
  perSourceStats,
  quotaRemaining,
  runOverview,
  sortRuns,
  summarizeStats,
} from "@/lib/queries/status";
import { formatDuration, reachLevel, sentimentDisplay } from "@/lib/format";
import { LOW_CONFIDENCE_THRESHOLD, type QuotaUsage } from "@/lib/types";

const NOW = new Date(FIXTURE_NOW); // Wed 2026-09-23
const visible = reluMentions.filter((m) => !m.hidden);

describe("weeklyBuckets", () => {
  it("starts weeks on Monday (UTC)", () => {
    expect(new Date(startOfWeekUtc(Date.parse("2026-09-23T09:00:00Z"))).toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(new Date(startOfWeekUtc(Date.parse("2026-09-27T23:59:00Z"))).toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(new Date(startOfWeekUtc(Date.parse("2026-09-21T00:00:00Z"))).toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });

  it("counts per week within a range, zero-filling empty weeks", () => {
    const inRange = filterMentions(visible, { sources: [], from: "2026-09-01", to: null, q: "", showHidden: false });
    const buckets = weeklyBuckets(inRange, { from: "2026-09-01", now: NOW });
    expect(buckets).toEqual([
      { weekStart: "2026-08-31", count: 0 },
      { weekStart: "2026-09-07", count: 3 },
      { weekStart: "2026-09-14", count: 6 },
      { weekStart: "2026-09-21", count: 4 },
    ]);
  });

  it("spans from the oldest mention to now and sums to the dated total", () => {
    const buckets = weeklyBuckets(visible, { now: NOW });
    expect(buckets[0].weekStart).toBe("2025-01-27"); // week of 2025-02-02
    expect(buckets.at(-1)!.weekStart).toBe("2026-09-21");
    expect(buckets.reduce((s, b) => s + b.count, 0)).toBe(visible.length);
    // consecutive weeks
    for (let i = 1; i < buckets.length; i++) {
      expect(Date.parse(buckets[i].weekStart) - Date.parse(buckets[i - 1].weekStart)).toBe(7 * 86400000);
    }
  });

  it("caps the range at MAX_WEEKS and skips undated mentions", () => {
    const old = { ...visible[0], id: "old", published_at: "2019-01-01T00:00:00Z" };
    const undated = { ...visible[0], id: "undated", published_at: null };
    const buckets = weeklyBuckets([old, undated, ...visible], { now: NOW });
    expect(buckets).toHaveLength(MAX_WEEKS);
    expect(undatedCount([old, undated])).toBe(1);
  });

  it("returns a single empty week when there is nothing", () => {
    expect(weeklyBuckets([], { now: NOW })).toEqual([{ weekStart: "2026-09-21", count: 0 }]);
  });
});

describe("sourceDistribution / topSourceNames / topByReach", () => {
  it("counts every source type in order, with shares", () => {
    const dist = sourceDistribution(visible);
    expect(dist.map((d) => [d.source, d.count])).toEqual([
      ["google_news", 6],
      ["gdelt", 5],
      ["reddit", 5],
      ["web_search", 5],
    ]);
    expect(dist.reduce((s, d) => s + d.share, 0)).toBeCloseTo(1);
    expect(dist[0].label).toBe("Google News");
    expect(sourceDistribution([]).every((d) => d.count === 0 && d.share === 0)).toBe(true);
  });

  it("ranks publishers by count", () => {
    expect(topSourceNames(visible, 2)).toEqual([
      { name: "universitetsavisa.no", count: 5 },
      { name: "adressa.no", count: 4 },
    ]);
  });

  it("top by reach excludes hidden mentions", () => {
    const top = topByReach(reluMentions, 3);
    expect(top.map((m) => m.reach_score)).toEqual([0.83, 0.78, 0.74]);
    // the hidden r/MachineLearning post has reach 0.71 and would be 4th
    expect(topByReach(reluMentions, 10).some((m) => m.hidden)).toBe(false);
  });
});

describe("quotaRemaining", () => {
  it("uses the current month for Tavily/Exa and lifetime for Serper", () => {
    const usage: QuotaUsage[] = [
      ...fixtureQuotaUsage,
      { provider: "tavily", month: "2026-08-01", credits_used: 990 },
      { provider: "serper", month: "2026-08-01", credits_used: 400 },
      { provider: "exa", month: "2026-09-01", credits_used: 2.5 },
    ];
    const q = Object.fromEntries(quotaRemaining(usage, NOW).map((r) => [r.provider, r]));
    expect(q.tavily).toMatchObject({ used: 412, limit: 1000, remaining: 588, lifetime: false, resetsOn: "2026-10-01" });
    expect(q.exa).toMatchObject({ used: 2.5, remaining: 7.5, unit: "USD / month" });
    expect(q.serper).toMatchObject({ used: 438, remaining: 2062, lifetime: true, resetsOn: null });
  });

  it("matches the fixture data and never goes below zero", () => {
    const q = quotaRemaining(fixtureQuotaUsage, NOW);
    expect(q.map((r) => r.remaining)).toEqual([588, 10, 2462]);
    const over = quotaRemaining([{ provider: "tavily", month: "2026-09-01", credits_used: 1200 }], NOW);
    expect(over[0]).toMatchObject({ remaining: 0, usedShare: 1 });
  });

  it("resets monthly quotas in a new month and accepts numeric strings", () => {
    const october = new Date("2026-10-02T00:00:00Z");
    const q = quotaRemaining(fixtureQuotaUsage, october);
    expect(q[0].remaining).toBe(1000);
    expect(q[2].remaining).toBe(2462); // Serper does not reset
    const str = quotaRemaining([{ provider: "exa", month: "2026-09-01", credits_used: "1.25" as unknown as number }], NOW);
    expect(str[1].used).toBe(1.25);
    expect(monthKey(NOW)).toBe("2026-09-01");
  });

  it("formats amounts in the provider's unit", () => {
    expect(formatQuotaAmount("exa", 7.5)).toBe("$7.50");
    expect(formatQuotaAmount("tavily", 1000)).toBe("1,000");
  });
});

describe("runs", () => {
  it("sorts newest first and summarises", () => {
    const sorted = sortRuns(fixtureRuns);
    expect(sorted.map((r) => r.started_at)).toEqual([...fixtureRuns.map((r) => r.started_at)].sort().reverse());
    const overview = runOverview(fixtureRuns);
    expect(overview.latest!.status).toBe("success");
    expect(overview.failedCount).toBe(1);
    expect(summarizeStats(fixtureRuns[0].stats)).toBe("84 fetched · 6 matched · 3 inserted");
    expect(summarizeStats({})).toBe("—");
    expect(perSourceStats(fixtureRuns[0].stats)).toContainEqual({ label: "Web", value: "skipped: not due" });
    expect(formatDuration(fixtureRuns[0].started_at, fixtureRuns[0].finished_at)).toBe("2 min");
    expect(formatDuration("2026-09-23T08:00:00Z", null)).toBeNull();
    expect(formatDuration("2026-09-23T08:00:00Z", "2026-09-23T08:00:45Z")).toBe("45 s");
    expect(formatDuration("2026-09-23T08:00:00Z", "2026-09-23T09:05:00Z")).toBe("1 h 5 min");
  });
});

describe("sentimentDisplay", () => {
  it('shows "Not classified" in v1 (no sentiment)', () => {
    expect(sentimentDisplay(null, null)).toEqual({ label: "Not classified", tone: "none", confidenceText: null });
    expect(visible.every((m) => sentimentDisplay(m.sentiment, m.confidence).label === "Not classified")).toBe(true);
  });

  it("maps confident sentiment to Positive / Neutral / Negative", () => {
    expect(sentimentDisplay("positive", 0.9)).toEqual({ label: "Positive", tone: "positive", confidenceText: "Confidence 90%" });
    expect(sentimentDisplay("neutral", LOW_CONFIDENCE_THRESHOLD).label).toBe("Neutral");
    expect(sentimentDisplay("negative", 0.75).label).toBe("Negative");
    expect(sentimentDisplay("negative", null).label).toBe("Negative");
  });

  it('shows low confidence as "Uncertain"', () => {
    expect(sentimentDisplay("positive", LOW_CONFIDENCE_THRESHOLD - 0.01)).toMatchObject({ label: "Uncertain", tone: "uncertain" });
    expect(sentimentDisplay("negative", 0.1).label).toBe("Uncertain");
  });
});

describe("reachLevel", () => {
  it("maps 0..1 to 0..5 dots", () => {
    expect([0, 0.05, 0.2, 0.21, 0.41, 0.66, 0.83, 1].map(reachLevel)).toEqual([0, 1, 1, 2, 3, 4, 5, 5]);
  });
});

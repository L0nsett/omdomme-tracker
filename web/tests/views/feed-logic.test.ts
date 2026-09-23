import { describe, expect, it } from "vitest";
import { reluMentions } from "@/lib/fixtures";
import {
  PAGE_SIZE,
  buildFeed,
  feedSearchString,
  filterMentions,
  parseFeedParams,
  parseHiddenForm,
  relevanceScore,
  sortMentions,
  type MentionFilters,
} from "@/lib/queries/feed";
import type { Mention } from "@/lib/types";

const noFilters: MentionFilters = { sources: [], from: null, to: null, q: "", showHidden: false };
const HIDDEN_ID = reluMentions.find((m) => m.hidden)!.id;
const idsEnd = (ms: Mention[]) => ms.map((m) => m.id.slice(-2));

describe("sortMentions", () => {
  it("chronological: newest published first", () => {
    const sorted = sortMentions(reluMentions, "chronological");
    expect(idsEnd(sorted).slice(0, 4)).toEqual(["02", "01", "07", "03"]);
    expect(sorted.at(-1)!.id.endsWith("13")).toBe(true); // 2025-02-02
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i - 1].published_at! >= sorted[i].published_at!).toBe(true);
    }
  });

  it("chronological: undated mentions go last, tie broken by fetched_at", () => {
    const undated = { ...reluMentions[0], id: "x-undated", published_at: null };
    const sorted = sortMentions([undated, ...reluMentions], "chronological");
    expect(sorted.at(-1)!.id).toBe("x-undated");
  });

  it("relevant: highest reach first (reach alone in v1)", () => {
    const sorted = sortMentions(reluMentions, "relevant");
    expect(idsEnd(sorted).slice(0, 3)).toEqual(["18", "04", "20"]);
    expect(sorted.map(relevanceScore)).toEqual([...sorted.map((m) => m.reach_score)].sort((a, b) => b - a));
  });

  it("relevant: equal reach falls back to newest first", () => {
    const sorted = sortMentions(reluMentions, "relevant").filter((m) => m.reach_score === 0.41);
    expect(idsEnd(sorted)).toEqual(["02", "01", "13"]);
  });

  it("does not mutate its input", () => {
    const copy = [...reluMentions];
    sortMentions(reluMentions, "relevant");
    expect(reluMentions).toEqual(copy);
  });
});

describe("filterMentions", () => {
  it("drops hidden mentions unless showHidden", () => {
    expect(filterMentions(reluMentions, noFilters).some((m) => m.id === HIDDEN_ID)).toBe(false);
    expect(filterMentions(reluMentions, { ...noFilters, showHidden: true })).toHaveLength(reluMentions.length);
  });

  it("filters by source type(s)", () => {
    const reddit = filterMentions(reluMentions, { ...noFilters, sources: ["reddit"] });
    expect(reddit).toHaveLength(5);
    expect(reddit.every((m) => m.source_type === "reddit")).toBe(true);
    const two = filterMentions(reluMentions, { ...noFilters, sources: ["gdelt", "web_search"] });
    expect(two).toHaveLength(10);
  });

  it("filters by inclusive date range on published_at", () => {
    const sept21 = filterMentions(reluMentions, { ...noFilters, from: "2026-09-21", to: "2026-09-21" });
    expect(idsEnd(sept21).sort()).toEqual(["01", "03", "07"]);
    const since = filterMentions(reluMentions, { ...noFilters, from: "2026-09-19" });
    expect(since.every((m) => m.published_at! >= "2026-09-19")).toBe(true);
    expect(since).toHaveLength(8);
    const until = filterMentions(reluMentions, { ...noFilters, to: "2025-12-31" });
    expect(idsEnd(until)).toEqual(["13"]);
  });

  it("excludes undated mentions once a date range is set", () => {
    const undated = { ...reluMentions[0], id: "x", published_at: null };
    expect(filterMentions([undated], noFilters)).toHaveLength(1);
    expect(filterMentions([undated], { ...noFilters, from: "2020-01-01" })).toHaveLength(0);
  });

  it("text search: case-insensitive over title, snippet and source name, all words", () => {
    expect(idsEnd(filterMentions(reluMentions, { ...noFilters, q: "HACKATHON" })).sort()).toEqual(["01", "02"]);
    expect(filterMentions(reluMentions, { ...noFilters, q: "150 studenter" })).toHaveLength(1); // snippet
    expect(filterMentions(reluMentions, { ...noFilters, q: "r/ntnu" })).toHaveLength(3); // source name
    expect(filterMentions(reluMentions, { ...noFilters, q: "hackathon nrk" })).toHaveLength(0);
  });
});

describe("buildFeed", () => {
  it("pages, counts and reports hidden mentions", () => {
    const params = { ...parseFeedParams({}), limit: PAGE_SIZE };
    const feed = buildFeed(reluMentions, params);
    expect(feed.total).toBe(21);
    expect(feed.items).toHaveLength(21);
    expect(feed.hasMore).toBe(false);
    expect(feed.hiddenCount).toBe(1);

    const small = buildFeed(reluMentions, { ...params, limit: 5 });
    expect(small.items).toHaveLength(5);
    expect(small.hasMore).toBe(true);
  });

  it("shows hidden mentions when asked", () => {
    const feed = buildFeed(reluMentions, { ...parseFeedParams({ hidden: "1" }) });
    expect(feed.total).toBe(22);
    expect(feed.items.some((m) => m.id === HIDDEN_ID)).toBe(true);
  });
});

describe("URL params", () => {
  it("parses defaults", () => {
    expect(parseFeedParams({})).toEqual({
      sources: [],
      from: null,
      to: null,
      q: "",
      sort: "chronological",
      showHidden: false,
      limit: PAGE_SIZE,
    });
  });

  it("parses and sanitises values", () => {
    const p = parseFeedParams({
      sort: "relevant",
      source: ["reddit", "bogus", "gdelt"],
      from: "2026-09-30",
      to: "2026-09-01",
      q: "  relu ",
      hidden: "1",
      limit: "60",
    });
    expect(p).toEqual({
      sources: ["reddit", "gdelt"],
      from: "2026-09-01", // swapped
      to: "2026-09-30",
      q: "relu",
      sort: "relevant",
      showHidden: true,
      limit: 75,
    });
    expect(parseFeedParams({ from: "yesterday", limit: "-4" })).toMatchObject({ from: null, limit: PAGE_SIZE });
    expect(parseFeedParams({ source: ["google_news", "gdelt", "reddit", "web_search"] }).sources).toEqual([]);
  });

  it("round-trips through the query string", () => {
    const p = parseFeedParams({ sort: "relevant", source: "reddit", q: "ai kurs", limit: "50", hidden: "1" });
    const qs = feedSearchString(p);
    const back = parseFeedParams(Object.fromEntries(new URLSearchParams(qs).entries()));
    expect(back).toEqual(p);
    expect(feedSearchString(parseFeedParams({}))).toBe("");
  });
});

describe("parseHiddenForm", () => {
  it("accepts a uuid and a boolean", () => {
    const fd = new FormData();
    fd.set("id", HIDDEN_ID);
    fd.set("hidden", "false");
    expect(parseHiddenForm(fd)).toEqual({ id: HIDDEN_ID, hidden: false });
  });

  it("rejects malformed input", () => {
    const fd = new FormData();
    fd.set("id", "1; drop table");
    fd.set("hidden", "true");
    expect(parseHiddenForm(fd)).toBeNull();
    fd.set("id", HIDDEN_ID);
    fd.set("hidden", "yes");
    expect(parseHiddenForm(fd)).toBeNull();
  });
});

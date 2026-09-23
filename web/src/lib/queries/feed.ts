/**
 * Feed behaviour as pure functions over Mention arrays. The pages fetch rows
 * with the thin queries in ./db.ts and then run them through these, so the
 * behaviour is defined (and tested) here against the fixtures.
 */
import { SOURCE_TYPES, type FeedSort, type Mention, type SourceType } from "@/lib/types";

export const PAGE_SIZE = 25;
/** Upper bound on rows loaded per request. Far above what one profile collects. */
export const MAX_ROWS = 2000;

export interface MentionFilters {
  /** Empty = all sources. */
  sources: SourceType[];
  /** Inclusive, YYYY-MM-DD (UTC). Compared with published_at. */
  from: string | null;
  /** Inclusive, YYYY-MM-DD (UTC). Compared with published_at. */
  to: string | null;
  /** Free text; every word must appear in title, snippet or source name. */
  q: string;
  showHidden: boolean;
}

export interface FeedParams extends MentionFilters {
  sort: FeedSort;
  /** How many items to show ("Load more" raises it by PAGE_SIZE). */
  limit: number;
}

export type SearchParams = Record<string, string | string[] | undefined>;

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Score used by the "Relevant" sort. v1: reach alone.
 * With Jev this becomes |sentiment_score| × reach × confidence (PLAN.md, Jev phase);
 * only this function has to change.
 */
export function relevanceScore(m: Mention): number {
  return m.reach_score;
}

function time(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/** published_at desc with missing dates last; ties broken by fetched_at desc, then id. */
export function compareChronological(a: Mention, b: Mention): number {
  const ta = time(a.published_at);
  const tb = time(b.published_at);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return tb - ta;
  }
  const fa = time(a.fetched_at) ?? 0;
  const fb = time(b.fetched_at) ?? 0;
  if (fa !== fb) return fb - fa;
  return a.id.localeCompare(b.id);
}

export function compareRelevant(a: Mention, b: Mention): number {
  const diff = relevanceScore(b) - relevanceScore(a);
  return diff !== 0 ? diff : compareChronological(a, b);
}

/** Returns a new, sorted array. */
export function sortMentions(mentions: readonly Mention[], sort: FeedSort): Mention[] {
  return [...mentions].sort(sort === "relevant" ? compareRelevant : compareChronological);
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string | null | undefined): string | null {
  if (!value || !DATE_RE.test(value)) return null;
  return Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) ? null : value;
}

/** Start of the `from` day, as an ISO timestamp (UTC). */
export function dateRangeStart(from: string): string {
  return `${from}T00:00:00.000Z`;
}

/** Start of the day after `to` (exclusive upper bound), as an ISO timestamp (UTC). */
export function dateRangeEndExclusive(to: string): string {
  const d = new Date(`${to}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

export function searchTerms(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesText(m: Mention, q: string): boolean {
  const terms = searchTerms(q);
  if (terms.length === 0) return true;
  const haystack = `${m.title}\n${m.snippet}\n${m.source_name}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

export function matchesDateRange(m: Mention, from: string | null, to: string | null): boolean {
  if (!from && !to) return true;
  const t = time(m.published_at);
  // An undated mention cannot be placed in a range, so it drops out once one is set.
  if (t === null) return false;
  if (from && t < new Date(dateRangeStart(from)).getTime()) return false;
  if (to && t >= new Date(dateRangeEndExclusive(to)).getTime()) return false;
  return true;
}

export function filterMentions(mentions: readonly Mention[], f: MentionFilters): Mention[] {
  return mentions.filter(
    (m) =>
      (f.showHidden || !m.hidden) &&
      (f.sources.length === 0 || f.sources.includes(m.source_type)) &&
      matchesDateRange(m, f.from, f.to) &&
      matchesText(m, f.q),
  );
}

export interface FeedResult {
  items: Mention[];
  /** Matches after filtering, before paging. */
  total: number;
  hasMore: boolean;
  /** Hidden mentions among the (otherwise) matching ones, for the "Show hidden" hint. */
  hiddenCount: number;
}

/** Filter, sort and page: everything the feed page does to the fetched rows. */
export function buildFeed(mentions: readonly Mention[], p: FeedParams): FeedResult {
  const withHidden = filterMentions(mentions, { ...p, showHidden: true });
  const visible = p.showHidden ? withHidden : withHidden.filter((m) => !m.hidden);
  const sorted = sortMentions(visible, p.sort);
  return {
    items: sorted.slice(0, p.limit),
    total: sorted.length,
    hasMore: sorted.length > p.limit,
    hiddenCount: withHidden.length - withHidden.filter((m) => !m.hidden).length,
  };
}

// ---------------------------------------------------------------------------
// URL search params <-> FeedParams
// ---------------------------------------------------------------------------

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function all(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).flatMap((s) => s.split(","));
}

function isSourceType(s: string): s is SourceType {
  return (SOURCE_TYPES as readonly string[]).includes(s);
}

/** Shared by feed and analytics: `source` (repeatable), `from`, `to`, `q`. */
export function parseFilterParams(sp: SearchParams): Omit<MentionFilters, "showHidden"> {
  const sources = [...new Set(all(sp.source).filter(isSourceType))];
  let from = validDate(first(sp.from));
  let to = validDate(first(sp.to));
  if (from && to && from > to) [from, to] = [to, from];
  return {
    // Every source ticked is the same as none ticked.
    sources: sources.length === SOURCE_TYPES.length ? [] : sources,
    from,
    to,
    q: (first(sp.q) ?? "").trim().slice(0, 200),
  };
}

export function parseFeedParams(sp: SearchParams): FeedParams {
  const limitRaw = Number.parseInt(first(sp.limit) ?? "", 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.min(MAX_ROWS, Math.max(PAGE_SIZE, Math.ceil(limitRaw / PAGE_SIZE) * PAGE_SIZE))
    : PAGE_SIZE;
  const hidden = first(sp.hidden);
  return {
    ...parseFilterParams(sp),
    sort: first(sp.sort) === "relevant" ? "relevant" : "chronological",
    showHidden: hidden === "1" || hidden === "true" || hidden === "on",
    limit,
  };
}

/** Builds the query string for a feed URL, leaving defaults out. */
export function feedSearchString(p: Partial<FeedParams>): string {
  const sp = new URLSearchParams();
  if (p.sort === "relevant") sp.set("sort", "relevant");
  for (const s of p.sources ?? []) sp.append("source", s);
  if (p.from) sp.set("from", p.from);
  if (p.to) sp.set("to", p.to);
  if (p.q) sp.set("q", p.q);
  if (p.showHidden) sp.set("hidden", "1");
  if (p.limit && p.limit > PAGE_SIZE) sp.set("limit", String(p.limit));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export function hasActiveFilters(f: Omit<MentionFilters, "showHidden">): boolean {
  return f.sources.length > 0 || !!f.from || !!f.to || f.q.length > 0;
}

// ---------------------------------------------------------------------------
// "Not relevant" form
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reads {id, hidden} from the mention card's form; null if the input is malformed. */
export function parseHiddenForm(form: FormData): { id: string; hidden: boolean } | null {
  const id = form.get("id");
  const hidden = form.get("hidden");
  if (typeof id !== "string" || !UUID_RE.test(id)) return null;
  if (hidden !== "true" && hidden !== "false") return null;
  return { id, hidden: hidden === "true" };
}

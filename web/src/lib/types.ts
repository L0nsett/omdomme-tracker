/**
 * Shared types for the web app (phase 0).
 *
 * CONTRACT: these mirror supabase/migrations/*.sql and worker/omdomme/contracts.py.
 * Phase 1 agents must not change them; ask the main agent if a change is needed.
 */

export type SourceType = "google_news" | "gdelt" | "reddit" | "web_search";
export const SOURCE_TYPES: readonly SourceType[] = ["google_news", "gdelt", "reddit", "web_search"];
export const SOURCE_LABELS: Record<SourceType, string> = {
  google_news: "Google News",
  gdelt: "GDELT",
  reddit: "Reddit",
  web_search: "Web",
};

export type BackfillStatus = "pending" | "running" | "done" | "failed";
export type MemberRole = "owner" | "member";
export type Sentiment = "positive" | "neutral" | "negative";
export type RunKind = "hourly" | "backfill";
export type RunStatus = "running" | "success" | "failed";
export type WebSearchProvider = "tavily" | "exa" | "serper";

/** Timestamps are ISO 8601 strings as returned by Supabase. */
export type Timestamp = string;
export type Uuid = string;

export interface Profile {
  id: Uuid;
  name: string;
  website_url: string | null;
  social_links: string[];
  created_at: Timestamp;
  backfill_status: BackfillStatus;
  last_web_search_at: Timestamp | null;
}

export interface ProfileMember {
  profile_id: Uuid;
  user_id: Uuid;
  role: MemberRole;
  joined_at: Timestamp;
}

export interface KeywordRule {
  id: Uuid;
  profile_id: Uuid;
  term: string;
  /** Non-empty => ambiguous term that only counts with one of these words. */
  context_terms: string[];
  is_exclusion: boolean;
  created_at: Timestamp;
}

/** Input shape for the `create_profile` RPC's `p_rules` argument. */
export interface KeywordRuleInput {
  term: string;
  context_terms: string[];
  is_exclusion: boolean;
}

export interface Invite {
  id: Uuid;
  profile_id: Uuid;
  token: string;
  created_by: Uuid | null;
  created_at: Timestamp;
  expires_at: Timestamp;
  used_at: Timestamp | null;
  used_by: Uuid | null;
}

export interface Mention {
  id: Uuid;
  profile_id: Uuid;
  url: string;
  title: string;
  snippet: string;
  source_type: SourceType;
  /** Publisher domain, or "r/<subreddit>" for Reddit. */
  source_name: string;
  published_at: Timestamp | null;
  fetched_at: Timestamp;
  /** 0..1 */
  reach_score: number;
  /** All sentiment fields are null in v1 ("Not classified"). */
  sentiment: Sentiment | null;
  sentiment_score: number | null;
  confidence: number | null;
  classifier_version: string | null;
  /** Marked "Not relevant" by a member. */
  hidden: boolean;
}

export interface RunStats {
  fetched?: number;
  matched?: number;
  inserted?: number;
  per_source?: Partial<Record<SourceType, number | string>>;
  [key: string]: unknown;
}

export interface Run {
  id: Uuid;
  kind: RunKind;
  /** null for hourly runs (all profiles). */
  profile_id: Uuid | null;
  started_at: Timestamp;
  finished_at: Timestamp | null;
  status: RunStatus;
  stats: RunStats;
  error: string | null;
}

export interface QuotaUsage {
  provider: WebSearchProvider;
  /** First day of month, YYYY-MM-DD. */
  month: string;
  /** Unit per provider: tavily=credits, exa=USD, serper=queries (lifetime). */
  credits_used: number;
}

/** Free limits, same as worker/omdomme/limits.py (see docs/source-limits.md). */
export const QUOTA_LIMITS: Record<WebSearchProvider, { limit: number; unit: string; lifetime: boolean }> = {
  tavily: { limit: 1000, unit: "credits / month", lifetime: false },
  exa: { limit: 10, unit: "USD / month", lifetime: false },
  serper: { limit: 2500, unit: "queries (one-time)", lifetime: true },
};

export type FeedSort = "chronological" | "relevant";

/** Confidence below this shows as "Uncertain" once Jev is live. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

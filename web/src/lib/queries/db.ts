/**
 * Thin database reads for the feed, analytics and status pages. Each takes a
 * server Supabase client (see @/lib/supabase/server); RLS limits every read to
 * the signed-in user's own profile. Sorting, text search and aggregation happen
 * in the pure functions next to this file.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Mention, Profile, QuotaUsage, Run, SourceType } from "@/lib/types";
import { MAX_ROWS, dateRangeEndExclusive, dateRangeStart } from "./feed";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = SupabaseClient<any, any, any>;

const MENTION_COLUMNS =
  "id, profile_id, url, title, snippet, source_type, source_name, published_at, fetched_at, reach_score, sentiment, sentiment_score, confidence, classifier_version, hidden";

export class QueryError extends Error {
  constructor(what: string, cause: { message?: string } | null) {
    super(`Could not load ${what}${cause?.message ? `: ${cause.message}` : ""}`);
    this.name = "QueryError";
  }
}

/** The caller's profile, or null when signed out or not yet a member of one. */
export async function fetchMyProfile(supabase: Client): Promise<Profile | null> {
  const { data: profileId, error } = await supabase.rpc("my_profile_id");
  if (error) throw new QueryError("your profile", error);
  if (!profileId) return null;
  const { data, error: selectError } = await supabase
    .from("profiles")
    .select("id, name, website_url, social_links, created_at, backfill_status, last_web_search_at")
    .eq("id", profileId as string)
    .maybeSingle();
  if (selectError) throw new QueryError("your profile", selectError);
  return (data as Profile | null) ?? null;
}

export interface MentionQuery {
  sources?: SourceType[];
  from?: string | null;
  to?: string | null;
  includeHidden?: boolean;
  limit?: number;
}

/**
 * Mentions of one profile, newest first, narrowed by source, date and hidden
 * state in the database (text search and final ordering are done in memory).
 */
export async function fetchMentions(
  supabase: Client,
  profileId: string,
  q: MentionQuery = {},
): Promise<{ rows: Mention[]; truncated: boolean }> {
  const limit = q.limit ?? MAX_ROWS;
  let query = supabase.from("mentions").select(MENTION_COLUMNS).eq("profile_id", profileId);
  if (q.sources && q.sources.length > 0) query = query.in("source_type", q.sources);
  if (!q.includeHidden) query = query.eq("hidden", false);
  if (q.from) query = query.gte("published_at", dateRangeStart(q.from));
  if (q.to) query = query.lt("published_at", dateRangeEndExclusive(q.to));
  const { data, error } = await query
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("fetched_at", { ascending: false })
    .limit(limit + 1);
  if (error) throw new QueryError("mentions", error);
  const rows = ((data ?? []) as Mention[]).map((m) => ({ ...m, reach_score: Number(m.reach_score) }));
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

/** Latest runs visible to the user: hourly runs plus their own profile's backfills. */
export async function fetchRuns(supabase: Client, limit = 20): Promise<Run[]> {
  const { data, error } = await supabase
    .from("runs")
    .select("id, kind, profile_id, started_at, finished_at, status, stats, error")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw new QueryError("runs", error);
  return (data ?? []) as Run[];
}

export async function fetchQuotaUsage(supabase: Client): Promise<QuotaUsage[]> {
  const { data, error } = await supabase.from("quota_usage").select("provider, month, credits_used");
  if (error) throw new QueryError("quota usage", error);
  return ((data ?? []) as QuotaUsage[]).map((u) => ({ ...u, credits_used: Number(u.credits_used) }));
}

/** Marks a mention "Not relevant" (hidden = true) or restores it. RLS scopes it to the user's profile. */
export async function updateMentionHidden(supabase: Client, id: string, hidden: boolean): Promise<void> {
  const { data, error } = await supabase.from("mentions").update({ hidden }).eq("id", id).select("id");
  if (error) throw new QueryError("mention", error);
  if (!data || data.length === 0) throw new QueryError("mention", { message: "not found" });
}

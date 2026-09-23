/**
 * Display helpers shared by the feed, analytics and status pages. Pure functions
 * only, so they are easy to test and safe in both server and client components.
 */
import { LOW_CONFIDENCE_THRESHOLD, type Sentiment } from "@/lib/types";

/** Dates are shown in Norwegian local time so server and browser agree. */
const TIME_ZONE = "Europe/Oslo";

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
});

const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "21 Sept 2026" style date, or `fallback` for a missing/invalid timestamp. */
export function formatDate(iso: string | null | undefined, fallback = "Unknown date"): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? fallback : dateFormat.format(d);
}

export function formatDateTime(iso: string | null | undefined, fallback = "—"): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? fallback : dateTimeFormat.format(d);
}

/** Human duration between two timestamps: "45 s", "2 min", "1 h 5 min". */
export function formatDuration(startIso: string, endIso: string | null): string | null {
  if (!endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatNumber(n: number, maxFractionDigits = 0): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: maxFractionDigits }).format(n);
}

// ---------------------------------------------------------------------------
// Sentiment (empty in v1, filled by Jev later)
// ---------------------------------------------------------------------------

export type SentimentLabel = "Not classified" | "Positive" | "Neutral" | "Negative" | "Uncertain";
export type SentimentTone = "none" | "positive" | "neutral" | "negative" | "uncertain";

export interface SentimentDisplay {
  label: SentimentLabel;
  tone: SentimentTone;
  /** "Confidence 82%" when known, otherwise null. */
  confidenceText: string | null;
}

const SENTIMENT_LABELS: Record<Sentiment, SentimentLabel> = {
  positive: "Positive",
  neutral: "Neutral",
  negative: "Negative",
};

/**
 * Maps the classifier output to what the mention card shows.
 * - no sentiment (v1)                        -> "Not classified"
 * - confidence below LOW_CONFIDENCE_THRESHOLD -> "Uncertain"
 * - otherwise                                -> Positive / Neutral / Negative
 * A sentiment without a confidence value is shown as-is.
 */
export function sentimentDisplay(sentiment: Sentiment | null, confidence: number | null): SentimentDisplay {
  if (!sentiment) return { label: "Not classified", tone: "none", confidenceText: null };
  const confidenceText = confidence === null ? null : `Confidence ${Math.round(confidence * 100)}%`;
  if (confidence !== null && confidence < LOW_CONFIDENCE_THRESHOLD) {
    return { label: "Uncertain", tone: "uncertain", confidenceText };
  }
  return { label: SENTIMENT_LABELS[sentiment], tone: sentiment, confidenceText };
}

// ---------------------------------------------------------------------------
// Reach
// ---------------------------------------------------------------------------

export const REACH_LEVELS = 5;

/** Maps a 0..1 reach score to 1..5 filled dots (0 only for a score of exactly 0). */
export function reachLevel(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  return Math.min(REACH_LEVELS, Math.max(1, Math.ceil(score * REACH_LEVELS)));
}

const REACH_WORDS = ["None", "Very low", "Low", "Medium", "High", "Very high"];

export function reachDescription(score: number): string {
  const level = reachLevel(score);
  return `Reach: ${REACH_WORDS[level]} (${level} of ${REACH_LEVELS}, score ${score.toFixed(2)})`;
}

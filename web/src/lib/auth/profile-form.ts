/**
 * Profile form <-> database conversion and validation (onboarding + settings).
 * Pure functions only, so they are unit tested without a browser or database.
 */
import type { KeywordRule, KeywordRuleInput, Profile } from "@/lib/types";

/** One ambiguous term row: `context` is a comma-separated list of context words. */
export interface AmbiguousRow {
  term: string;
  context: string;
}

/** Raw form state as edited in the browser. Multi-value text fields hold one item per line. */
export interface ProfileFormState {
  name: string;
  website: string;
  socialLinks: string;
  exactTerms: string;
  ambiguous: AmbiguousRow[];
  exclusions: string;
}

export const EMPTY_FORM: ProfileFormState = {
  name: "",
  website: "",
  socialLinks: "",
  exactTerms: "",
  ambiguous: [{ term: "", context: "" }],
  exclusions: "",
};

/** Validated, normalised values ready for create_profile / profile updates. */
export interface ProfileData {
  name: string;
  websiteUrl: string | null;
  socialLinks: string[];
  rules: KeywordRuleInput[];
}

export type ProfileFieldErrors = Partial<Record<"name" | "website" | "socialLinks" | "terms" | "ambiguous" | "exclusions", string>>;

export type ValidationResult = { ok: true; data: ProfileData } | { ok: false; errors: ProfileFieldErrors };

export const MAX_NAME_LENGTH = 120;
export const MAX_TERM_LENGTH = 100;
export const MAX_RULES = 50;

/** Splits text on newlines (and commas when `commas`), trims, drops empties, dedupes case-insensitively. */
export function splitList(text: string, { commas = false }: { commas?: boolean } = {}): string[] {
  const parts = text.split(commas ? /[\n,]/ : /\n/);
  return dedupe(parts.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean));
}

export function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

/**
 * Normalises a user-typed URL: trims, adds https:// when no scheme is given, and
 * accepts only http(s) URLs with a plausible host. Returns null when invalid.
 */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname.includes(".") && url.hostname !== "localhost") return null;
  if (url.username || url.password) return null;
  // Keep what the user typed (minus a lone trailing slash) rather than URL.href's re-encoding.
  return withScheme.replace(/\/$/, "");
}

/** Accepts unknown input (e.g. parsed JSON from a form) and coerces it into ProfileFormState. */
export function coerceFormState(input: unknown): ProfileFormState {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const rows = Array.isArray(obj.ambiguous) ? obj.ambiguous : [];
  return {
    name: str(obj.name),
    website: str(obj.website),
    socialLinks: str(obj.socialLinks),
    exactTerms: str(obj.exactTerms),
    exclusions: str(obj.exclusions),
    ambiguous: rows.map((r) => {
      const row = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
      return { term: str(row.term), context: str(row.context) };
    }),
  };
}

export function validateProfileForm(state: ProfileFormState): ValidationResult {
  const errors: ProfileFieldErrors = {};

  const name = state.name.replace(/\s+/g, " ").trim();
  if (!name) errors.name = "Enter the name of the organization.";
  else if (name.length > MAX_NAME_LENGTH) errors.name = `Keep the name under ${MAX_NAME_LENGTH} characters.`;

  let websiteUrl: string | null = null;
  if (state.website.trim()) {
    websiteUrl = normalizeUrl(state.website);
    if (!websiteUrl) errors.website = "Enter a valid website address, e.g. https://example.com.";
  }

  const socialLinks: string[] = [];
  const badLinks: string[] = [];
  for (const raw of splitList(state.socialLinks)) {
    const url = normalizeUrl(raw);
    if (url) socialLinks.push(url);
    else badLinks.push(raw);
  }
  if (badLinks.length) errors.socialLinks = `Not a valid link: ${badLinks.join(", ")}`;

  const exact = splitList(state.exactTerms);

  const ambiguous: { term: string; context: string[] }[] = [];
  for (const row of state.ambiguous) {
    const term = row.term.replace(/\s+/g, " ").trim();
    const context = splitList(row.context, { commas: true });
    if (!term && context.length === 0) continue;
    if (!term) {
      errors.ambiguous = "Each row with context words needs an ambiguous term.";
      continue;
    }
    if (context.length === 0) {
      errors.ambiguous = `Add at least one context word for “${term}”, or list it as an exact search term.`;
      continue;
    }
    ambiguous.push({ term, context });
  }

  const exclusions = splitList(state.exclusions);

  // Cross-list duplicates: a term may only be used once.
  const seen = new Map<string, string>();
  const dupes: string[] = [];
  const ambiguousKept: typeof ambiguous = [];
  for (const term of exact) seen.set(term.toLowerCase(), "exact");
  for (const row of ambiguous) {
    const key = row.term.toLowerCase();
    if (seen.get(key) === "ambiguous") {
      // Same ambiguous term twice: merge context words.
      const existing = ambiguousKept.find((r) => r.term.toLowerCase() === key)!;
      existing.context = dedupe([...existing.context, ...row.context]);
      continue;
    }
    if (seen.has(key)) dupes.push(row.term);
    seen.set(key, "ambiguous");
    ambiguousKept.push({ ...row });
  }
  const exclusionConflicts = exclusions.filter((t) => seen.has(t.toLowerCase()));
  if (dupes.length) errors.ambiguous = `Already listed as an exact search term: ${dupes.join(", ")}`;
  if (exclusionConflicts.length)
    errors.exclusions = `A word cannot be both a search term and an exclusion: ${exclusionConflicts.join(", ")}`;

  const allTerms = [...exact, ...ambiguousKept.map((r) => r.term), ...exclusions, ...ambiguousKept.flatMap((r) => r.context)];
  const tooLong = allTerms.find((t) => t.length > MAX_TERM_LENGTH);
  if (tooLong) errors.terms = `Keep each term under ${MAX_TERM_LENGTH} characters (“${tooLong.slice(0, 30)}…”).`;
  else if (exact.length + ambiguousKept.length === 0 && !errors.ambiguous)
    errors.terms = "Add at least one search term (exact or ambiguous with context words).";
  else if (exact.length + ambiguousKept.length + exclusions.length > MAX_RULES)
    errors.terms = `Use at most ${MAX_RULES} terms in total.`;

  if (Object.keys(errors).length) return { ok: false, errors };

  const rules: KeywordRuleInput[] = [
    ...exact.map((term) => ({ term, context_terms: [], is_exclusion: false })),
    ...ambiguousKept.map((r) => ({ term: r.term, context_terms: r.context, is_exclusion: false })),
    ...exclusions.map((term) => ({ term, context_terms: [], is_exclusion: true })),
  ];
  return { ok: true, data: { name, websiteUrl, socialLinks, rules } };
}

/** Builds the editable form state from stored rows (settings page). */
export function profileToFormState(
  profile: Pick<Profile, "name" | "website_url" | "social_links">,
  rules: Pick<KeywordRule, "term" | "context_terms" | "is_exclusion">[],
): ProfileFormState {
  const exact = rules.filter((r) => !r.is_exclusion && r.context_terms.length === 0).map((r) => r.term);
  const ambiguous = rules
    .filter((r) => !r.is_exclusion && r.context_terms.length > 0)
    .map((r) => ({ term: r.term, context: r.context_terms.join(", ") }));
  const exclusions = rules.filter((r) => r.is_exclusion).map((r) => r.term);
  return {
    name: profile.name,
    website: profile.website_url ?? "",
    socialLinks: profile.social_links.join("\n"),
    exactTerms: exact.join("\n"),
    ambiguous: ambiguous.length ? ambiguous : [{ term: "", context: "" }],
    exclusions: exclusions.join("\n"),
  };
}

function ruleKey(r: Pick<KeywordRuleInput, "term" | "context_terms" | "is_exclusion">): string {
  return JSON.stringify([
    r.term.toLowerCase(),
    r.is_exclusion,
    r.is_exclusion ? [] : [...r.context_terms].map((c) => c.toLowerCase()).sort(),
  ]);
}

/**
 * Minimal change set to turn the stored rules into `next`: unchanged rules are kept
 * (so their ids/created_at survive), removed ones deleted, new ones inserted.
 */
export function diffRules(
  existing: Pick<KeywordRule, "id" | "term" | "context_terms" | "is_exclusion">[],
  next: KeywordRuleInput[],
): { toInsert: KeywordRuleInput[]; toDeleteIds: string[] } {
  const remaining = new Map<string, string[]>();
  for (const r of existing) {
    const key = ruleKey(r);
    remaining.set(key, [...(remaining.get(key) ?? []), r.id]);
  }
  const toInsert: KeywordRuleInput[] = [];
  for (const r of next) {
    const ids = remaining.get(ruleKey(r));
    if (ids && ids.length) ids.shift();
    else toInsert.push(r);
  }
  const toDeleteIds = [...remaining.values()].flat();
  return { toInsert, toDeleteIds };
}

/**
 * Extracts an invite token from either a full invite URL (…/invite/<token>) or a
 * bare token. Returns null when nothing token-like is found.
 */
export function parseInviteToken(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const fromPath = text.match(/\/invite\/([A-Za-z0-9_-]+)/);
  const token = fromPath ? fromPath[1] : text;
  return /^[A-Za-z0-9_-]{16,128}$/.test(token) ? token : null;
}

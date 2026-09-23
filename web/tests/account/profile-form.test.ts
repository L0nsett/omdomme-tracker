import { describe, expect, it } from "vitest";
import { fixtureKeywordRules, fixtureProfiles, RELU_PROFILE_ID } from "@/lib/fixtures";
import {
  EMPTY_FORM,
  coerceFormState,
  diffRules,
  normalizeUrl,
  parseInviteToken,
  profileToFormState,
  splitList,
  validateProfileForm,
  type ProfileFormState,
} from "@/lib/auth/profile-form";

const form = (patch: Partial<ProfileFormState>): ProfileFormState => ({ ...EMPTY_FORM, ...patch });

describe("splitList", () => {
  it("trims, collapses whitespace, drops empties and dedupes case-insensitively", () => {
    expect(splitList("  ReLU NTNU \n\nrelu   ntnu\nReLU\n")).toEqual(["ReLU NTNU", "ReLU"]);
  });
  it("splits on commas when asked", () => {
    expect(splitList("NTNU, Trondheim,,ntnu\nlinjeforening", { commas: true })).toEqual(["NTNU", "Trondheim", "linjeforening"]);
  });
});

describe("normalizeUrl", () => {
  it("accepts http(s) URLs and adds https:// when missing", () => {
    expect(normalizeUrl("https://www.relu-ntnu.no/")).toBe("https://www.relu-ntnu.no");
    expect(normalizeUrl(" relu-ntnu.no ")).toBe("https://relu-ntnu.no");
    expect(normalizeUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeUrl("https://www.instagram.com/relu_ntnu")).toBe("https://www.instagram.com/relu_ntnu");
  });
  it("rejects invalid or unsafe URLs", () => {
    for (const bad of ["", "not a url", "javascript:alert(1)", "ftp://x.com", "https://nodot", "https://user:pw@x.com", "mailto:a@b.no"]) {
      expect(normalizeUrl(bad)).toBeNull();
    }
  });
});

describe("validateProfileForm", () => {
  it("builds rules in the KeywordRuleInput shape", () => {
    const result = validateProfileForm(
      form({
        name: "  ReLU   NTNU ",
        website: "relu-ntnu.no",
        socialLinks: "https://www.instagram.com/relu_ntnu\n\nhttps://www.instagram.com/relu_ntnu",
        exactTerms: "ReLU NTNU\nrelu ntnu",
        ambiguous: [
          { term: "ReLU", context: "NTNU, Trondheim" },
          { term: "", context: "" },
        ],
        exclusions: "activation function\nleaky ReLU",
      }),
    );
    expect(result).toEqual({
      ok: true,
      data: {
        name: "ReLU NTNU",
        websiteUrl: "https://relu-ntnu.no",
        socialLinks: ["https://www.instagram.com/relu_ntnu"],
        rules: [
          { term: "ReLU NTNU", context_terms: [], is_exclusion: false },
          { term: "ReLU", context_terms: ["NTNU", "Trondheim"], is_exclusion: false },
          { term: "activation function", context_terms: [], is_exclusion: true },
          { term: "leaky ReLU", context_terms: [], is_exclusion: true },
        ],
      },
    });
  });

  it("requires a name and at least one search term", () => {
    const result = validateProfileForm(form({ name: "   ", exclusions: "foo" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.name).toBeTruthy();
      expect(result.errors.terms).toMatch(/at least one search term/);
    }
  });

  it("accepts an ambiguous term alone as the search term", () => {
    const result = validateProfileForm(form({ name: "X", ambiguous: [{ term: "ReLU", context: "NTNU" }] }));
    expect(result.ok).toBe(true);
  });

  it("rejects an ambiguous term without context words, and context without a term", () => {
    const a = validateProfileForm(form({ name: "X", exactTerms: "X AS", ambiguous: [{ term: "ReLU", context: " , " }] }));
    expect(a.ok || a.errors.ambiguous).toMatch(/context word/);
    const b = validateProfileForm(form({ name: "X", exactTerms: "X AS", ambiguous: [{ term: "", context: "NTNU" }] }));
    expect(b.ok || b.errors.ambiguous).toMatch(/needs an ambiguous term/);
  });

  it("rejects invalid website and social links", () => {
    const result = validateProfileForm(form({ name: "X", exactTerms: "X", website: "not a url", socialLinks: "ok.com\njavascript:alert(1)" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.website).toBeTruthy();
      expect(result.errors.socialLinks).toContain("javascript:alert(1)");
    }
  });

  it("rejects a term used both as search term and exclusion", () => {
    const result = validateProfileForm(form({ name: "X", exactTerms: "ReLU NTNU", exclusions: "relu ntnu" }));
    expect(result.ok || result.errors.exclusions).toMatch(/both a search term and an exclusion/);
  });

  it("rejects a term that is both exact and ambiguous, but merges repeated ambiguous rows", () => {
    const dup = validateProfileForm(form({ name: "X", exactTerms: "ReLU", ambiguous: [{ term: "relu", context: "NTNU" }] }));
    expect(dup.ok).toBe(false);
    const merged = validateProfileForm(
      form({ name: "X", ambiguous: [{ term: "ReLU", context: "NTNU" }, { term: "relu", context: "Trondheim, ntnu" }] }),
    );
    expect(merged.ok && merged.data.rules).toEqual([{ term: "ReLU", context_terms: ["NTNU", "Trondheim"], is_exclusion: false }]);
  });

  it("limits term length", () => {
    const result = validateProfileForm(form({ name: "X", exactTerms: "a".repeat(101) }));
    expect(result.ok || result.errors.terms).toMatch(/under 100/);
  });

  it("treats a website that is only whitespace as empty", () => {
    const result = validateProfileForm(form({ name: "X", exactTerms: "X", website: "   " }));
    expect(result.ok && result.data.websiteUrl).toBeNull();
  });
});

describe("coerceFormState", () => {
  it("turns untrusted input into a well-formed state", () => {
    expect(coerceFormState(null)).toEqual({ ...EMPTY_FORM, ambiguous: [] });
    expect(coerceFormState({ name: 5, ambiguous: [null, { term: "a", context: 1 }] })).toEqual({
      ...EMPTY_FORM,
      ambiguous: [
        { term: "", context: "" },
        { term: "a", context: "" },
      ],
    });
  });
});

describe("rules <-> form round trip", () => {
  const profile = fixtureProfiles.find((p) => p.id === RELU_PROFILE_ID)!;
  const rules = fixtureKeywordRules.filter((r) => r.profile_id === RELU_PROFILE_ID);

  it("converts stored rules into form fields", () => {
    const state = profileToFormState(profile, rules);
    expect(state.name).toBe("ReLU NTNU");
    expect(state.exactTerms).toBe("ReLU NTNU");
    expect(state.ambiguous).toEqual([{ term: "ReLU", context: "NTNU, Trondheim, studentorganisasjon, student organization, linjeforening" }]);
    expect(state.exclusions).toBe("activation function\naktiveringsfunksjon\nleaky ReLU");
    expect(state.socialLinks.split("\n")).toEqual(profile.social_links);
  });

  it("validating the form state gives back the same rules and an empty diff", () => {
    const result = validateProfileForm(profileToFormState(profile, rules));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const simplify = (r: { term: string; context_terms: string[]; is_exclusion: boolean }) => [r.term, r.context_terms, r.is_exclusion];
    expect(result.data.rules.map(simplify).sort()).toEqual(rules.map(simplify).sort());
    expect(diffRules(rules, result.data.rules)).toEqual({ toInsert: [], toDeleteIds: [] });
  });

  it("an empty profile gives one blank ambiguous row", () => {
    expect(profileToFormState({ name: "X", website_url: null, social_links: [] }, []).ambiguous).toEqual([{ term: "", context: "" }]);
  });
});

describe("diffRules", () => {
  const existing = [
    { id: "1", term: "ReLU NTNU", context_terms: [], is_exclusion: false },
    { id: "2", term: "ReLU", context_terms: ["NTNU", "Trondheim"], is_exclusion: false },
    { id: "3", term: "leaky ReLU", context_terms: [], is_exclusion: true },
  ];

  it("keeps unchanged rules, inserts new ones and deletes removed ones", () => {
    const next = [
      { term: "relu ntnu", context_terms: [], is_exclusion: false }, // same, different case
      { term: "ReLU", context_terms: ["Trondheim", "NTNU", "linjeforening"], is_exclusion: false }, // changed context
      { term: "Omega", context_terms: [], is_exclusion: false }, // new
    ];
    const { toInsert, toDeleteIds } = diffRules(existing, next);
    expect(toInsert).toEqual([next[1], next[2]]);
    expect(toDeleteIds.sort()).toEqual(["2", "3"]);
  });

  it("treats context order as irrelevant", () => {
    const next = [
      { term: "ReLU NTNU", context_terms: [], is_exclusion: false },
      { term: "ReLU", context_terms: ["Trondheim", "NTNU"], is_exclusion: false },
      { term: "leaky ReLU", context_terms: [], is_exclusion: true },
    ];
    expect(diffRules(existing, next)).toEqual({ toInsert: [], toDeleteIds: [] });
  });

  it("switching a term from search to exclusion replaces it", () => {
    const { toInsert, toDeleteIds } = diffRules(existing.slice(0, 1), [{ term: "ReLU NTNU", context_terms: [], is_exclusion: true }]);
    expect(toInsert).toHaveLength(1);
    expect(toDeleteIds).toEqual(["1"]);
  });
});

describe("parseInviteToken", () => {
  const token = "testinvitetoken0000000000000000000000000000000001";
  it("accepts a bare token or a full invite URL", () => {
    expect(parseInviteToken(token)).toBe(token);
    expect(parseInviteToken(`  https://tracker.example/invite/${token}  `)).toBe(token);
    expect(parseInviteToken(`http://localhost:3000/invite/${token}?x=1`)).toBe(token);
  });
  it("rejects junk", () => {
    expect(parseInviteToken("")).toBeNull();
    expect(parseInviteToken("short")).toBeNull();
    expect(parseInviteToken("https://tracker.example/feed")).toBeNull();
    expect(parseInviteToken("abc def ghi jkl mno pqr")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { SOURCE_TYPES } from "@/lib/types";
import { OTHER_PROFILE_ID, fixtureMentions, reluMentions } from "./index";

describe("fixtures", () => {
  it("cover every source type and keep sentiment empty (v1)", () => {
    expect(new Set(reluMentions.map((m) => m.source_type))).toEqual(new Set(SOURCE_TYPES));
    expect(fixtureMentions.every((m) => m.sentiment === null && m.confidence === null)).toBe(true);
  });

  it("include one hidden mention and one mention from another profile", () => {
    expect(reluMentions.filter((m) => m.hidden)).toHaveLength(1);
    expect(fixtureMentions.some((m) => m.profile_id === OTHER_PROFILE_ID)).toBe(true);
  });
});

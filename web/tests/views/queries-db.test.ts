import { beforeEach, describe, expect, it, vi } from "vitest";
import { RELU_PROFILE_ID, fixtureProfiles, reluMentions } from "@/lib/fixtures";

/**
 * A fake Supabase query builder: records every call and resolves to `result`.
 * No network, no real Supabase.
 */
function fakeClient(results: Record<string, { data: unknown; error: unknown }>, rpc?: { data: unknown; error: unknown }) {
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "gte", "lt", "order", "limit", "update", "maybeSingle"]) {
      b[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return b;
      };
    }
    b.then = (resolve: (v: unknown) => void) => resolve(results[table]);
    return b;
  };
  return {
    calls,
    client: {
      from: (table: string) => builder(table),
      rpc: vi.fn(async () => rpc ?? { data: null, error: null }),
    },
  };
}

const { fetchMentions, fetchMyProfile, fetchQuotaUsage, updateMentionHidden } = await import("@/lib/queries/db");

describe("db queries", () => {
  it("fetchMyProfile returns null without a profile", async () => {
    const { client } = fakeClient({}, { data: null, error: null });
    expect(await fetchMyProfile(client as never)).toBeNull();
  });

  it("fetchMyProfile loads the profile behind my_profile_id()", async () => {
    const { client, calls } = fakeClient({ profiles: { data: fixtureProfiles[0], error: null } }, { data: RELU_PROFILE_ID, error: null });
    expect(await fetchMyProfile(client as never)).toEqual(fixtureProfiles[0]);
    expect(client.rpc).toHaveBeenCalledWith("my_profile_id");
    expect(calls).toContainEqual({ table: "profiles", method: "eq", args: ["id", RELU_PROFILE_ID] });
  });

  it("fetchMentions pushes source/date/hidden filters into the query", async () => {
    const { client, calls } = fakeClient({ mentions: { data: reluMentions.slice(0, 3), error: null } });
    const res = await fetchMentions(client as never, RELU_PROFILE_ID, {
      sources: ["reddit"],
      from: "2026-09-01",
      to: "2026-09-30",
      limit: 2,
    });
    expect(res.rows).toHaveLength(2);
    expect(res.truncated).toBe(true);
    const m = calls.map((c) => [c.method, ...c.args]);
    expect(m).toContainEqual(["eq", "profile_id", RELU_PROFILE_ID]);
    expect(m).toContainEqual(["in", "source_type", ["reddit"]]);
    expect(m).toContainEqual(["eq", "hidden", false]);
    expect(m).toContainEqual(["gte", "published_at", "2026-09-01T00:00:00.000Z"]);
    expect(m).toContainEqual(["lt", "published_at", "2026-10-01T00:00:00.000Z"]);
    expect(m).toContainEqual(["limit", 3]);
  });

  it("fetchMentions throws a readable error", async () => {
    const { client } = fakeClient({ mentions: { data: null, error: { message: "boom" } } });
    await expect(fetchMentions(client as never, RELU_PROFILE_ID)).rejects.toThrow("Could not load mentions: boom");
  });

  it("fetchQuotaUsage converts numeric strings", async () => {
    const { client } = fakeClient({ quota_usage: { data: [{ provider: "exa", month: "2026-09-01", credits_used: "1.5" }], error: null } });
    expect((await fetchQuotaUsage(client as never))[0].credits_used).toBe(1.5);
  });

  it("updateMentionHidden only updates `hidden` and fails when no row matched", async () => {
    const ok = fakeClient({ mentions: { data: [{ id: "x" }], error: null } });
    await updateMentionHidden(ok.client as never, "x", true);
    expect(ok.calls).toContainEqual({ table: "mentions", method: "update", args: [{ hidden: true }] });
    const none = fakeClient({ mentions: { data: [], error: null } });
    await expect(updateMentionHidden(none.client as never, "x", true)).rejects.toThrow(/not found/);
  });
});

describe("setMentionHidden server action", () => {
  const revalidatePath = vi.fn();
  const fake = fakeClient({ mentions: { data: [{ id: reluMentions[0].id }], error: null } });

  beforeEach(() => {
    vi.resetModules();
    revalidatePath.mockReset();
    fake.calls.length = 0;
    vi.doMock("next/cache", () => ({ revalidatePath }));
    vi.doMock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));
  });

  it("hides the mention and revalidates feed + analytics", async () => {
    const { setMentionHidden } = await import("@/app/(app)/feed/actions");
    const fd = new FormData();
    fd.set("id", reluMentions[0].id);
    fd.set("hidden", "true");
    await setMentionHidden(fd);
    expect(fake.calls).toContainEqual({ table: "mentions", method: "eq", args: ["id", reluMentions[0].id] });
    expect(revalidatePath).toHaveBeenCalledWith("/feed");
    expect(revalidatePath).toHaveBeenCalledWith("/analytics");
  });

  it("rejects malformed input without touching the database", async () => {
    const { setMentionHidden } = await import("@/app/(app)/feed/actions");
    const fd = new FormData();
    fd.set("id", "not-a-uuid");
    fd.set("hidden", "true");
    await expect(setMentionHidden(fd)).rejects.toThrow("Invalid request");
    expect(fake.calls).toHaveLength(0);
  });
});

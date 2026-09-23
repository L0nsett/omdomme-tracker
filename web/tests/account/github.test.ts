import { describe, expect, it, vi } from "vitest";
import { startBackfill } from "@/lib/auth/backfill";
import { dispatchBackfill, dispatchUrl, githubConfigFromEnv } from "@/lib/github";

const CONFIG = { repo: "owner/omdomme-tracker", token: "test-token-not-real" };
const PROFILE = "11111111-1111-4111-8111-111111111111";

function mockFetch(response: Response | Error) {
  return vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
}

describe("githubConfigFromEnv", () => {
  it("reads token and repo", () => {
    expect(githubConfigFromEnv({ GITHUB_DISPATCH_TOKEN: " t ", GITHUB_REPO: "a/b" })).toEqual({ token: "t", repo: "a/b" });
  });
  it("returns null when missing or malformed", () => {
    expect(githubConfigFromEnv({})).toBeNull();
    expect(githubConfigFromEnv({ GITHUB_DISPATCH_TOKEN: "t" })).toBeNull();
    expect(githubConfigFromEnv({ GITHUB_REPO: "a/b" })).toBeNull();
    expect(githubConfigFromEnv({ GITHUB_DISPATCH_TOKEN: "t", GITHUB_REPO: "not-a-repo" })).toBeNull();
    expect(githubConfigFromEnv({ GITHUB_DISPATCH_TOKEN: "t", GITHUB_REPO: "a/b/../c" })).toBeNull();
  });
});

describe("dispatchBackfill", () => {
  it("posts a repository_dispatch with the right URL, headers and body", async () => {
    const fetchImpl = mockFetch(new Response(null, { status: 204 }));
    const result = await dispatchBackfill(PROFILE, CONFIG, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/owner/omdomme-tracker/dispatches");
    expect(url).toBe(dispatchUrl(CONFIG.repo));
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token-not-real");
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(JSON.parse(init.body as string)).toEqual({ event_type: "backfill", client_payload: { profile_id: PROFILE } });
  });

  it("reports GitHub errors with status and message", async () => {
    const fetchImpl = mockFetch(Response.json({ message: "Bad credentials" }, { status: 401 }));
    const result = await dispatchBackfill(PROFILE, CONFIG, fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, reason: "github_error", status: 401, message: "GitHub returned 401: Bad credentials" });
  });

  it("handles non-JSON error bodies", async () => {
    const fetchImpl = mockFetch(new Response("oops", { status: 500 }));
    const result = await dispatchBackfill(PROFILE, CONFIG, fetchImpl as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: false, reason: "github_error", status: 500 });
  });

  it("handles network errors", async () => {
    const fetchImpl = mockFetch(new Error("ECONNRESET"));
    const result = await dispatchBackfill(PROFILE, CONFIG, fetchImpl as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: false, reason: "network_error" });
  });

  it("does not call GitHub when not configured", async () => {
    const fetchImpl = mockFetch(new Response(null, { status: 204 }));
    const result = await dispatchBackfill(PROFILE, null, fetchImpl as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: false, reason: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("startBackfill", () => {
  const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("dispatches for the caller's own profile and returns 202", async () => {
    const fetchImpl = mockFetch(new Response(null, { status: 204 }));
    const out = await startBackfill({
      getProfileId: async () => PROFILE,
      getBackfillStatus: async () => "pending",
      config: CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.status).toBe(202);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).client_payload.profile_id).toBe(PROFILE);
  });

  it("returns 403 without a profile and never calls GitHub", async () => {
    const fetchImpl = mockFetch(new Response(null, { status: 204 }));
    const out = await startBackfill({
      getProfileId: async () => null,
      getBackfillStatus: async () => null,
      config: CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns 409 when history is already fetched or running", async () => {
    for (const status of ["done", "running"] as const) {
      const fetchImpl = mockFetch(new Response(null, { status: 204 }));
      const out = await startBackfill({
        getProfileId: async () => PROFILE,
        getBackfillStatus: async () => status,
        config: CONFIG,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(out.status).toBe(409);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("allows retrying a failed backfill", async () => {
    const fetchImpl = mockFetch(new Response(null, { status: 204 }));
    const out = await startBackfill({
      getProfileId: async () => PROFILE,
      getBackfillStatus: async () => "failed",
      config: CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out.status).toBe(202);
  });

  it("returns 503 and logs when env is missing", async () => {
    const spy = quiet();
    const out = await startBackfill({
      getProfileId: async () => PROFILE,
      getBackfillStatus: async () => "pending",
      config: null,
    });
    expect(out.status).toBe(503);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns 502 when GitHub rejects the dispatch", async () => {
    const spy = quiet();
    const out = await startBackfill({
      getProfileId: async () => PROFILE,
      getBackfillStatus: async () => "pending",
      config: CONFIG,
      fetchImpl: mockFetch(new Response("{}", { status: 404 })) as unknown as typeof fetch,
    });
    expect(out.status).toBe(502);
    spy.mockRestore();
  });
});

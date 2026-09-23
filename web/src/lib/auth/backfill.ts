/**
 * Starting a backfill run for the signed-in user's profile. Shared by
 * POST /api/backfill and the onboarding Server Action.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BackfillStatus } from "@/lib/types";
import { dispatchBackfill, githubConfigFromEnv, type GithubDispatchConfig } from "@/lib/github";

export interface BackfillDeps {
  /** Profile of the signed-in user (rpc my_profile_id), never a client-sent id. */
  getProfileId: () => Promise<string | null>;
  getBackfillStatus: (profileId: string) => Promise<BackfillStatus | null>;
  config: GithubDispatchConfig | null;
  fetchImpl?: typeof fetch;
}

export interface BackfillOutcome {
  status: 202 | 403 | 409 | 502 | 503;
  body: { ok: boolean; message: string; profile_id?: string };
}

/** Only new (pending) or failed profiles may start a backfill, so the button can't be used to burn quota. */
const STARTABLE: BackfillStatus[] = ["pending", "failed"];

export async function startBackfill(deps: BackfillDeps): Promise<BackfillOutcome> {
  const profileId = await deps.getProfileId();
  if (!profileId) {
    return { status: 403, body: { ok: false, message: "You are not a member of any profile." } };
  }
  const current = await deps.getBackfillStatus(profileId);
  if (current && !STARTABLE.includes(current)) {
    return {
      status: 409,
      body: { ok: false, message: `History is already ${current === "done" ? "fetched" : "being fetched"}.` },
    };
  }
  const result = await dispatchBackfill(profileId, deps.config, deps.fetchImpl);
  if (result.ok) {
    return { status: 202, body: { ok: true, message: "Fetching history…", profile_id: profileId } };
  }
  console.error(`[backfill] ${result.reason}: ${result.message}`);
  if (result.reason === "not_configured") {
    return {
      status: 503,
      body: { ok: false, message: "History fetching is not configured on this server. The hourly run will still collect new mentions." },
    };
  }
  return { status: 502, body: { ok: false, message: "Could not start fetching history. Please try again later." } };
}

/** Wires startBackfill to a request-scoped Supabase client and the server env. */
export function startBackfillForUser(supabase: SupabaseClient, fetchImpl?: typeof fetch): Promise<BackfillOutcome> {
  return startBackfill({
    getProfileId: async () => {
      const { data, error } = await supabase.rpc("my_profile_id");
      if (error) throw error;
      return (data as string | null) ?? null;
    },
    getBackfillStatus: async (profileId) => {
      const { data } = await supabase.from("profiles").select("backfill_status").eq("id", profileId).maybeSingle();
      return (data?.backfill_status as BackfillStatus | undefined) ?? null;
    },
    config: githubConfigFromEnv(),
    fetchImpl,
  });
}

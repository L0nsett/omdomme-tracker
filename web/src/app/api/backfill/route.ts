import { NextResponse } from "next/server";
import { startBackfillForUser } from "@/lib/auth/backfill";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Starts the history (backfill) run for the caller's own profile. Any profile id in
 * the request body is ignored: the profile comes from my_profile_id().
 */
export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, message: "Sign in first." }, { status: 401 });
  }
  try {
    const outcome = await startBackfillForUser(supabase);
    return NextResponse.json(outcome.body, { status: outcome.status });
  } catch (err) {
    console.error("[backfill] unexpected error", err);
    return NextResponse.json({ ok: false, message: "Could not start fetching history." }, { status: 500 });
  }
}

"use server";

import { redirect } from "next/navigation";
import type { ProfileFormResult } from "@/components/account/profile-form";
import type { InviteFormState } from "@/components/account/join-invite";
import { startBackfillForUser } from "@/lib/auth/backfill";
import { rpcErrorMessage } from "@/lib/auth/messages";
import { coerceFormState, parseInviteToken, validateProfileForm } from "@/lib/auth/profile-form";
import { createClient } from "@/lib/supabase/server";

function parseProfileField(fd: FormData): unknown {
  try {
    return JSON.parse(String(fd.get("profile") ?? "{}"));
  } catch {
    return {};
  }
}

export async function createProfile(_prev: ProfileFormResult, fd: FormData): Promise<ProfileFormResult> {
  const result = validateProfileForm(coerceFormState(parseProfileField(fd)));
  if (!result.ok) return { errors: result.errors };
  const { name, websiteUrl, socialLinks, rules } = result.data;

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_profile", {
    p_name: name,
    p_website_url: websiteUrl,
    p_social_links: socialLinks,
    p_rules: rules,
  });
  if (error) {
    console.error("[onboarding] create_profile failed:", error.code, error.message);
    return { error: rpcErrorMessage(error) };
  }

  // Start fetching history. A failure here must not block onboarding: the feed shows
  // the pending state and the hourly run still collects new mentions.
  try {
    const outcome = await startBackfillForUser(supabase);
    if (outcome.status !== 202) console.warn(`[onboarding] backfill not started (${outcome.status}): ${outcome.body.message}`);
  } catch (err) {
    console.error("[onboarding] backfill dispatch threw:", err);
  }
  redirect("/feed");
}

export async function joinWithInvite(_prev: InviteFormState, fd: FormData): Promise<InviteFormState> {
  const input = String(fd.get("invite") ?? "");
  const token = parseInviteToken(input);
  if (!token) return { error: "Paste the full invite link you received, e.g. https://…/invite/abc123…", value: input };

  const supabase = await createClient();
  const { error } = await supabase.rpc("accept_invite", { p_token: token });
  if (error) return { error: rpcErrorMessage(error), value: input };
  redirect("/feed");
}

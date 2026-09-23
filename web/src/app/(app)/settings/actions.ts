"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { InviteLinkState } from "@/components/account/invite-panel";
import type { LeaveState } from "@/components/account/leave-profile";
import type { ProfileFormResult } from "@/components/account/profile-form";
import { inviteUrl } from "@/lib/auth/origin";
import { coerceFormState, diffRules, validateProfileForm } from "@/lib/auth/profile-form";
import { requestOrigin } from "@/lib/auth/request-origin";
import { createClient } from "@/lib/supabase/server";
import type { KeywordRule } from "@/lib/types";

const GENERIC = "Something went wrong. Please try again.";

export async function updateProfile(_prev: ProfileFormResult, fd: FormData): Promise<ProfileFormResult> {
  let raw: unknown = {};
  try {
    raw = JSON.parse(String(fd.get("profile") ?? "{}"));
  } catch {
    // Treated as an empty form below.
  }
  const result = validateProfileForm(coerceFormState(raw));
  if (!result.ok) return { errors: result.errors };
  const { name, websiteUrl, socialLinks, rules } = result.data;

  const supabase = await createClient();
  const { data: profileId } = await supabase.rpc("my_profile_id");
  if (!profileId) return { error: "You are not a member of any profile." };

  const { error: updateError } = await supabase
    .from("profiles")
    .update({ name, website_url: websiteUrl, social_links: socialLinks })
    .eq("id", profileId);
  if (updateError) {
    console.error("[settings] profile update failed:", updateError.message);
    return { error: GENERIC };
  }

  const { data: existing, error: rulesError } = await supabase
    .from("keyword_rules")
    .select("id, term, context_terms, is_exclusion")
    .eq("profile_id", profileId);
  if (rulesError) {
    console.error("[settings] loading rules failed:", rulesError.message);
    return { error: GENERIC };
  }

  // Insert new rules before deleting old ones, so a failure never leaves the profile without terms.
  const { toInsert, toDeleteIds } = diffRules((existing ?? []) as Pick<KeywordRule, "id" | "term" | "context_terms" | "is_exclusion">[], rules);
  if (toInsert.length) {
    const { error } = await supabase.from("keyword_rules").insert(toInsert.map((r) => ({ ...r, profile_id: profileId })));
    if (error) {
      console.error("[settings] inserting rules failed:", error.message);
      return { error: GENERIC };
    }
  }
  if (toDeleteIds.length) {
    const { error } = await supabase.from("keyword_rules").delete().in("id", toDeleteIds);
    if (error) {
      console.error("[settings] deleting rules failed:", error.message);
      return { error: GENERIC };
    }
  }

  revalidatePath("/", "layout");
  return { message: "Saved. The changes apply to future updates only." };
}

export async function createInvite(): Promise<InviteLinkState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profileId } = await supabase.rpc("my_profile_id");
  if (!user || !profileId) return { error: "You are not a member of any profile." };

  const { data, error } = await supabase
    .from("invites")
    .insert({ profile_id: profileId, created_by: user.id })
    .select("token, expires_at")
    .single();
  if (error || !data) {
    console.error("[settings] creating invite failed:", error?.message);
    return { error: "Could not create an invite link. Please try again." };
  }
  revalidatePath("/settings");
  return { url: inviteUrl(await requestOrigin(), data.token), expiresAt: data.expires_at };
}

export async function leaveProfile(): Promise<LeaveState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("leave_profile");
  if (error) {
    console.error("[settings] leave_profile failed:", error.message);
    return { error: "Could not leave the profile. Please try again." };
  }
  revalidatePath("/", "layout");
  redirect("/onboarding");
}

"use server";

import { redirect } from "next/navigation";
import { authErrorMessage, validateEmail, validateNewPassword } from "@/lib/auth/messages";
import { safeNextPath } from "@/lib/auth/redirect";
import { requestOrigin } from "@/lib/auth/request-origin";
import { createClient } from "@/lib/supabase/server";
import type { AuthFormState } from "@/components/account/auth-forms";

function field(fd: FormData, name: string): string {
  const v = fd.get(name);
  return typeof v === "string" ? v : "";
}

function callbackUrl(origin: string, next: string): string {
  return `${origin}/auth/callback?next=${encodeURIComponent(next)}`;
}

export async function signIn(_prev: AuthFormState, fd: FormData): Promise<AuthFormState> {
  const email = field(fd, "email").trim();
  const password = field(fd, "password");
  const next = safeNextPath(field(fd, "next"));
  const emailError = validateEmail(email);
  if (emailError) return { error: emailError, email };
  if (!password) return { error: "Enter your password.", email };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: authErrorMessage(error), email };
  redirect(next);
}

export async function signUp(_prev: AuthFormState, fd: FormData): Promise<AuthFormState> {
  const email = field(fd, "email").trim();
  const password = field(fd, "password");
  const confirm = field(fd, "confirm");
  const next = safeNextPath(field(fd, "next"), "/onboarding");
  const invalid = validateEmail(email) ?? validateNewPassword(password, confirm);
  if (invalid) return { error: invalid, email };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: callbackUrl(await requestOrigin(), next) },
  });
  if (error) return { error: authErrorMessage(error), email };
  // With email confirmation on, Supabase hides existing accounts behind a user with no identities.
  if (data.user && data.user.identities?.length === 0) {
    return { error: authErrorMessage({ code: "user_already_exists" }), email };
  }
  if (data.session) redirect(next);
  return {
    message: `We sent a confirmation link to ${email}. Open it to finish creating your account.`,
    email,
  };
}

export async function signInWithGoogle(fd: FormData): Promise<void> {
  const next = safeNextPath(field(fd, "next"));
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: callbackUrl(await requestOrigin(), next) },
  });
  if (error || !data.url) {
    redirect(`/login?error=${encodeURIComponent(authErrorMessage(error))}`);
  }
  redirect(data.url);
}

export async function requestPasswordReset(_prev: AuthFormState, fd: FormData): Promise<AuthFormState> {
  const email = field(fd, "email").trim();
  const emailError = validateEmail(email);
  if (emailError) return { error: emailError, email };

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: callbackUrl(await requestOrigin(), "/reset-password"),
  });
  // Rate limits are worth reporting; anything else is hidden so we don't reveal which emails exist.
  if (error && (error.status === 429 || error.code?.startsWith("over_"))) {
    return { error: authErrorMessage(error), email };
  }
  if (error) console.error("[auth] resetPasswordForEmail failed:", error.message);
  return { message: `If an account exists for ${email}, we sent a link to reset the password.`, email };
}

export async function updatePassword(_prev: AuthFormState, fd: FormData): Promise<AuthFormState> {
  const password = field(fd, "password");
  const confirm = field(fd, "confirm");
  const invalid = validateNewPassword(password, confirm);
  if (invalid) return { error: invalid };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Your reset link has expired. Request a new one." };
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: authErrorMessage(error) };
  redirect("/feed");
}

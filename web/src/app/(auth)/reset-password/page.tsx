import type { Metadata } from "next";
import Link from "next/link";
import { AuthCard } from "@/components/account/auth-card";
import { ResetPasswordForm } from "@/components/account/auth-forms";
import { createClient } from "@/lib/supabase/server";
import { updatePassword } from "../actions";

export const metadata: Metadata = { title: "Set a new password · Reputation Tracker" };
export const dynamic = "force-dynamic";

/** Reached from the recovery email via /auth/callback, which signs the user in first. */
export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <AuthCard title="Link expired" subtitle="This password reset link is no longer valid.">
        <Link
          href="/forgot-password"
          className="inline-flex w-full items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
        >
          Request a new link
        </Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Set a new password" subtitle={`For ${user.email ?? "your account"}.`}>
      <ResetPasswordForm action={updatePassword} />
    </AuthCard>
  );
}

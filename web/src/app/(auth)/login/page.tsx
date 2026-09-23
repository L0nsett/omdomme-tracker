import type { Metadata } from "next";
import { AuthCard } from "@/components/account/auth-card";
import { LoginForm } from "@/components/account/auth-forms";
import { safeNextPath } from "@/lib/auth/redirect";
import { signIn, signInWithGoogle } from "../actions";

export const metadata: Metadata = { title: "Sign in · Reputation Tracker" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = params.next ? safeNextPath(params.next) : undefined;
  const joining = next?.startsWith("/invite/");
  return (
    <AuthCard
      title="Sign in"
      subtitle={joining ? "Sign in or create an account to join the profile you were invited to." : "Welcome back."}
    >
      <LoginForm action={signIn} googleAction={signInWithGoogle} next={next} initialError={params.error?.slice(0, 300)} />
    </AuthCard>
  );
}

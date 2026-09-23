import type { Metadata } from "next";
import { AuthCard } from "@/components/account/auth-card";
import { SignupForm } from "@/components/account/auth-forms";
import { safeNextPath } from "@/lib/auth/redirect";
import { signInWithGoogle, signUp } from "../actions";

export const metadata: Metadata = { title: "Sign up · Reputation Tracker" };

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const params = await searchParams;
  const next = params.next ? safeNextPath(params.next) : undefined;
  return (
    <AuthCard title="Create your account" subtitle="Track what the web says about your organization.">
      <SignupForm action={signUp} googleAction={signInWithGoogle} next={next} />
    </AuthCard>
  );
}

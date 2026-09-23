import type { Metadata } from "next";
import { AuthCard } from "@/components/account/auth-card";
import { ForgotPasswordForm } from "@/components/account/auth-forms";
import { requestPasswordReset } from "../actions";

export const metadata: Metadata = { title: "Forgot password · Reputation Tracker" };

export default function ForgotPasswordPage() {
  return (
    <AuthCard title="Forgot your password?" subtitle="Enter your email and we will send you a link to set a new one.">
      <ForgotPasswordForm action={requestPasswordReset} />
    </AuthCard>
  );
}

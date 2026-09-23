import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { authErrorMessage } from "@/lib/auth/messages";
import { safeNextPath } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const OTP_TYPES: EmailOtpType[] = ["signup", "invite", "magiclink", "recovery", "email_change", "email"];

/**
 * Landing point for Google OAuth, email confirmation and password recovery links.
 * Supports both the PKCE `?code=` flow and the `?token_hash=&type=` email template flow.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const next = safeNextPath(searchParams.get("next"), type === "recovery" ? "/reset-password" : "/feed");

  const providerError = searchParams.get("error_description") ?? searchParams.get("error");
  if (providerError) {
    return failure(origin, searchParams.get("error_code") ?? undefined, providerError);
  }

  const supabase = await createClient();
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
    return failure(origin, error.code, error.message);
  }
  if (tokenHash && type && OTP_TYPES.includes(type)) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(`${origin}${next}`);
    return failure(origin, error.code, error.message);
  }
  return failure(origin, undefined, "Missing sign-in code.");
}

function failure(origin: string, code: string | undefined, message: string) {
  console.error(`[auth/callback] ${code ?? "error"}: ${message}`);
  const text = code ? authErrorMessage({ code, message }) : "That sign-in link did not work. Please try again.";
  return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(text)}`);
}

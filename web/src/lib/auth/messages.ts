/**
 * Human-readable messages for Supabase Auth and RPC errors. Pure, unit tested.
 */

interface ErrorLike {
  code?: string | null;
  message?: string | null;
  status?: number | null;
}

const GENERIC = "Something went wrong. Please try again.";

const AUTH_MESSAGES: Record<string, string> = {
  invalid_credentials: "Wrong email or password.",
  email_not_confirmed: "Please confirm your email address first. Check your inbox for the link.",
  user_already_exists: "An account with this email already exists. Try signing in instead.",
  email_exists: "An account with this email already exists. Try signing in instead.",
  weak_password: "That password is too weak. Use at least 8 characters with a mix of letters and numbers.",
  same_password: "The new password must be different from the old one.",
  over_email_send_rate_limit: "Too many emails sent. Please wait a few minutes and try again.",
  over_request_rate_limit: "Too many attempts. Please wait a moment and try again.",
  email_address_invalid: "That email address is not valid.",
  signup_disabled: "Sign-ups are currently disabled.",
  otp_expired: "This link has expired. Please request a new one.",
  bad_code_verifier: "The sign-in link was opened in a different browser. Please try again in this browser.",
  flow_state_not_found: "The sign-in session expired. Please try again.",
  session_not_found: "Your session has expired. Please sign in again.",
  provider_disabled: "This sign-in method is not enabled.",
};

export function authErrorMessage(error: ErrorLike | null | undefined): string {
  if (!error) return GENERIC;
  if (error.code && AUTH_MESSAGES[error.code]) return AUTH_MESSAGES[error.code];
  const msg = (error.message ?? "").toLowerCase();
  if (msg.includes("invalid login credentials")) return AUTH_MESSAGES.invalid_credentials;
  if (msg.includes("email not confirmed")) return AUTH_MESSAGES.email_not_confirmed;
  if (msg.includes("already registered")) return AUTH_MESSAGES.user_already_exists;
  if (msg.includes("password should be")) return AUTH_MESSAGES.weak_password;
  if (msg.includes("rate limit") || error.status === 429) return AUTH_MESSAGES.over_request_rate_limit;
  return GENERIC;
}

/** Messages for the create_profile / accept_invite RPCs (Postgres error codes from the migration). */
export function rpcErrorMessage(error: ErrorLike | null | undefined): string {
  switch (error?.code) {
    case "23505":
      return "You already belong to a profile. Leave it in Settings before creating or joining another.";
    case "P0002":
      return "This invite link is invalid, has already been used, or has expired. Ask for a new one.";
    case "28000":
      return "Your session has expired. Please sign in again.";
    case "23514":
      return "Some of the values are not allowed. Check the form and try again.";
    default:
      return GENERIC;
  }
}

export const MIN_PASSWORD_LENGTH = 8;

export function validateEmail(email: string): string | null {
  if (!email) return "Enter your email address.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "That email address is not valid.";
  return null;
}

export function validateNewPassword(password: string, confirm?: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (confirm !== undefined && password !== confirm) return "The passwords do not match.";
  return null;
}

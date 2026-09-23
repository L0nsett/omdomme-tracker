/**
 * Pure routing rules used by middleware.ts. Kept free of Next/Supabase imports so
 * they can be unit tested.
 */

export type RouteKind =
  | "auth-page" // /login, /signup, /forgot-password
  | "reset-password" // reached with a recovery session; always allowed through
  | "auth-route" // /auth/* (callback, signout)
  | "api" // /api/* (route handlers answer with JSON, never redirects)
  | "invite" // /invite/<token>
  | "onboarding"
  | "app"; // everything else (feed, analytics, status, settings, /)

const AUTH_PAGES = ["/login", "/signup", "/forgot-password"];

function matches(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

export function routeKind(pathname: string): RouteKind {
  if (AUTH_PAGES.some((p) => matches(pathname, p))) return "auth-page";
  if (matches(pathname, "/reset-password")) return "reset-password";
  if (matches(pathname, "/auth")) return "auth-route";
  if (matches(pathname, "/api")) return "api";
  if (matches(pathname, "/invite")) return "invite";
  if (matches(pathname, "/onboarding")) return "onboarding";
  return "app";
}

/** True when the redirect decision depends on whether the user has a profile. */
export function needsProfileLookup(kind: RouteKind, signedIn: boolean): boolean {
  return signedIn && (kind === "auth-page" || kind === "onboarding" || kind === "app");
}

export interface RedirectInput {
  pathname: string;
  /** Path + query string of the current request, used for `next`. */
  pathWithSearch?: string;
  signedIn: boolean;
  /** Only consulted when needsProfileLookup() is true. */
  hasProfile?: boolean;
}

/**
 * Returns the path (with query) to redirect to, or null to let the request through.
 */
export function redirectFor({ pathname, pathWithSearch, signedIn, hasProfile }: RedirectInput): string | null {
  const kind = routeKind(pathname);
  const here = pathWithSearch ?? pathname;

  switch (kind) {
    case "auth-route":
    case "api":
    case "reset-password":
      return null;
    case "auth-page":
      if (!signedIn) return null;
      return hasProfile ? "/feed" : "/onboarding";
    case "invite":
      return signedIn ? null : loginWithNext(here);
    case "onboarding":
      if (!signedIn) return loginWithNext(here);
      return hasProfile ? "/feed" : null;
    case "app":
      if (!signedIn) return loginWithNext(pathname === "/" ? "/feed" : here);
      return hasProfile ? null : "/onboarding";
  }
}

function loginWithNext(next: string): string {
  return `/login?next=${encodeURIComponent(next)}`;
}

/**
 * Sanitises a user-controlled `next` value so it can only point at a path on this
 * site (prevents open redirects such as `//evil.com` or `https://evil.com`).
 */
export function safeNextPath(next: string | null | undefined, fallback = "/feed"): string {
  if (!next || typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f]/.test(next)) return fallback;
  return next;
}

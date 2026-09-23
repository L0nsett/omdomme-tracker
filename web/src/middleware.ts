import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { needsProfileLookup, redirectFor, routeKind } from "@/lib/auth/redirect";
import { supabaseAnonKey, supabaseUrl } from "@/lib/supabase/env";

/**
 * Refreshes the Supabase session cookie on every request and applies the routing
 * rules in lib/auth/redirect.ts. At most two cheap calls: getUser() and, only when
 * the decision needs it, rpc('my_profile_id').
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl(), supabaseAnonKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  // Must run right after creating the client: it refreshes an expired session.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname, search } = request.nextUrl;
  const signedIn = Boolean(user);
  let hasProfile: boolean | undefined;
  if (needsProfileLookup(routeKind(pathname), signedIn)) {
    const { data, error } = await supabase.rpc("my_profile_id");
    // On a lookup error, assume a profile exists so we don't bounce users to onboarding.
    hasProfile = error ? true : Boolean(data);
  }

  const target = redirectFor({ pathname, pathWithSearch: pathname + search, signedIn, hasProfile });
  if (!target) return response;

  const url = request.nextUrl.clone();
  const [targetPath, targetQuery] = target.split("?");
  url.pathname = targetPath;
  url.search = targetQuery ? `?${targetQuery}` : "";
  const redirect = NextResponse.redirect(url);
  // Keep refreshed session cookies on the redirect.
  response.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  return redirect;
}

export const config = {
  matcher: [
    // Everything except Next internals and static files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)",
  ],
};

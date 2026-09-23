import { describe, expect, it } from "vitest";
import { needsProfileLookup, redirectFor, routeKind, safeNextPath } from "@/lib/auth/redirect";

describe("routeKind", () => {
  it.each([
    ["/login", "auth-page"],
    ["/signup", "auth-page"],
    ["/forgot-password", "auth-page"],
    ["/reset-password", "reset-password"],
    ["/auth/callback", "auth-route"],
    ["/auth/signout", "auth-route"],
    ["/api/backfill", "api"],
    ["/invite/abc", "invite"],
    ["/onboarding", "onboarding"],
    ["/feed", "app"],
    ["/settings", "app"],
    ["/", "app"],
    ["/loginx", "app"],
    ["/authors", "app"],
  ])("%s -> %s", (path, kind) => {
    expect(routeKind(path)).toBe(kind);
  });
});

describe("redirectFor", () => {
  const out = { signedIn: false };
  const noProfile = { signedIn: true, hasProfile: false };
  const withProfile = { signedIn: true, hasProfile: true };

  it("sends signed-out users on protected pages to login with next", () => {
    expect(redirectFor({ pathname: "/feed", pathWithSearch: "/feed?sort=relevant", ...out })).toBe(
      "/login?next=%2Ffeed%3Fsort%3Drelevant",
    );
    expect(redirectFor({ pathname: "/settings", ...out })).toBe("/login?next=%2Fsettings");
    expect(redirectFor({ pathname: "/onboarding", ...out })).toBe("/login?next=%2Fonboarding");
    expect(redirectFor({ pathname: "/", ...out })).toBe("/login?next=%2Ffeed");
  });

  it("sends signed-out invite visitors to login, keeping the invite as next", () => {
    expect(redirectFor({ pathname: "/invite/tok123", ...out })).toBe("/login?next=%2Finvite%2Ftok123");
  });

  it("lets signed-out users reach auth pages, auth routes, api and reset-password", () => {
    for (const p of ["/login", "/signup", "/forgot-password", "/reset-password", "/auth/callback", "/api/backfill"]) {
      expect(redirectFor({ pathname: p, ...out })).toBeNull();
    }
  });

  it("sends signed-in users without a profile to onboarding", () => {
    expect(redirectFor({ pathname: "/feed", ...noProfile })).toBe("/onboarding");
    expect(redirectFor({ pathname: "/settings", ...noProfile })).toBe("/onboarding");
    expect(redirectFor({ pathname: "/login", ...noProfile })).toBe("/onboarding");
    expect(redirectFor({ pathname: "/onboarding", ...noProfile })).toBeNull();
    expect(redirectFor({ pathname: "/invite/x", ...noProfile })).toBeNull();
  });

  it("sends signed-in users with a profile away from login and onboarding", () => {
    expect(redirectFor({ pathname: "/login", ...withProfile })).toBe("/feed");
    expect(redirectFor({ pathname: "/signup", ...withProfile })).toBe("/feed");
    expect(redirectFor({ pathname: "/onboarding", ...withProfile })).toBe("/feed");
    expect(redirectFor({ pathname: "/feed", ...withProfile })).toBeNull();
    expect(redirectFor({ pathname: "/settings", ...withProfile })).toBeNull();
    // The invite page explains that they already belong to a profile.
    expect(redirectFor({ pathname: "/invite/x", ...withProfile })).toBeNull();
  });

  it("never redirects signed-in users away from reset-password or auth routes", () => {
    expect(redirectFor({ pathname: "/reset-password", ...withProfile })).toBeNull();
    expect(redirectFor({ pathname: "/auth/signout", ...withProfile })).toBeNull();
  });
});

describe("needsProfileLookup", () => {
  it("only looks up the profile for signed-in users where it matters", () => {
    expect(needsProfileLookup("app", false)).toBe(false);
    expect(needsProfileLookup("app", true)).toBe(true);
    expect(needsProfileLookup("auth-page", true)).toBe(true);
    expect(needsProfileLookup("onboarding", true)).toBe(true);
    expect(needsProfileLookup("invite", true)).toBe(false);
    expect(needsProfileLookup("api", true)).toBe(false);
    expect(needsProfileLookup("auth-route", true)).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("keeps local paths", () => {
    expect(safeNextPath("/invite/abc")).toBe("/invite/abc");
    expect(safeNextPath("/feed?sort=relevant")).toBe("/feed?sort=relevant");
  });
  it("rejects open redirects and junk", () => {
    for (const bad of ["https://evil.com", "//evil.com", "/\\evil.com", "evil.com", "", null, undefined, "/a\nb"]) {
      expect(safeNextPath(bad)).toBe("/feed");
    }
    expect(safeNextPath("//evil.com", "/onboarding")).toBe("/onboarding");
  });
});

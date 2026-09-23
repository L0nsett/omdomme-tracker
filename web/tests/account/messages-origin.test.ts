import { describe, expect, it } from "vitest";
import { authErrorMessage, rpcErrorMessage, validateEmail, validateNewPassword } from "@/lib/auth/messages";
import { inviteUrl, originFromHeaders } from "@/lib/auth/origin";

describe("authErrorMessage", () => {
  it("maps known Supabase codes and messages", () => {
    expect(authErrorMessage({ code: "invalid_credentials" })).toBe("Wrong email or password.");
    expect(authErrorMessage({ message: "Invalid login credentials" })).toBe("Wrong email or password.");
    expect(authErrorMessage({ message: "Email not confirmed" })).toMatch(/confirm your email/);
    expect(authErrorMessage({ code: "weak_password" })).toMatch(/too weak/);
    expect(authErrorMessage({ status: 429 })).toMatch(/Too many attempts/);
  });
  it("falls back to a generic message without leaking internals", () => {
    expect(authErrorMessage({ message: "pq: relation does not exist" })).toBe("Something went wrong. Please try again.");
    expect(authErrorMessage(null)).toBe("Something went wrong. Please try again.");
  });
});

describe("rpcErrorMessage", () => {
  it("maps the migration's error codes", () => {
    expect(rpcErrorMessage({ code: "23505" })).toMatch(/already belong to a profile/);
    expect(rpcErrorMessage({ code: "P0002" })).toMatch(/invalid, has already been used, or has expired/);
    expect(rpcErrorMessage({ code: "XX000" })).toBe("Something went wrong. Please try again.");
  });
});

describe("validateEmail / validateNewPassword", () => {
  it("validates", () => {
    expect(validateEmail("")).toBeTruthy();
    expect(validateEmail("nope")).toBeTruthy();
    expect(validateEmail("leon@example.com")).toBeNull();
    expect(validateNewPassword("short")).toMatch(/8 characters/);
    expect(validateNewPassword("longenough1", "different1")).toMatch(/do not match/);
    expect(validateNewPassword("longenough1", "longenough1")).toBeNull();
  });
});

describe("originFromHeaders", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  it("prefers a well-formed Origin header", () => {
    expect(originFromHeaders(h({ origin: "https://tracker.example", host: "internal:3000" }))).toBe("https://tracker.example");
  });
  it("uses forwarded host and proto behind a proxy", () => {
    expect(originFromHeaders(h({ "x-forwarded-host": "tracker.vercel.app", "x-forwarded-proto": "https", host: "x" }))).toBe(
      "https://tracker.vercel.app",
    );
  });
  it("defaults to http for localhost and https elsewhere", () => {
    expect(originFromHeaders(h({ host: "localhost:3000" }))).toBe("http://localhost:3000");
    expect(originFromHeaders(h({ host: "tracker.example" }))).toBe("https://tracker.example");
  });
  it("ignores malformed values", () => {
    expect(originFromHeaders(h({ origin: "null", host: "tracker.example" }))).toBe("https://tracker.example");
    expect(originFromHeaders(h({}))).toBe("http://localhost:3000");
  });
  it("builds invite URLs", () => {
    expect(inviteUrl("https://tracker.example", "abc123")).toBe("https://tracker.example/invite/abc123");
  });
});

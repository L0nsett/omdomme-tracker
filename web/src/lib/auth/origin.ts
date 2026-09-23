/**
 * Works out the public origin (scheme + host) of the current request, for links we
 * hand out (invite URLs, OAuth / email redirect targets). Pure, unit tested.
 */
export function originFromHeaders(h: Pick<Headers, "get">): string {
  const origin = h.get("origin");
  if (origin && /^https?:\/\/[^/\s]+$/i.test(origin)) return origin;
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0].trim();
  if (!host || /[\s/]/.test(host)) return "http://localhost:3000";
  const forwardedProto = (h.get("x-forwarded-proto") ?? "").split(",")[0].trim();
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const proto =
    forwardedProto === "http" || forwardedProto === "https" ? forwardedProto : isLocal ? "http" : "https";
  return `${proto}://${host}`;
}

export function inviteUrl(origin: string, token: string): string {
  return `${origin}/invite/${encodeURIComponent(token)}`;
}

/** Date formatting for account pages (fixed locale + UTC so server and client render the same). */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" });
}

import { Card, EmptyState, Notice } from "@/components/ui";
import { formatDate, formatDateTime, formatDuration } from "@/lib/format";
import {
  formatQuotaAmount,
  perSourceStats,
  quotaRemaining,
  runOverview,
  sortRuns,
  summarizeStats,
} from "@/lib/queries/status";
import type { QuotaUsage, Run, RunStatus } from "@/lib/types";

const STATUS_CLASSES: Record<RunStatus, string> = {
  success: "bg-emerald-50 text-emerald-800 border-emerald-200",
  failed: "bg-rose-50 text-rose-800 border-rose-200",
  running: "bg-sky-50 text-sky-800 border-sky-200",
};
const STATUS_TEXT: Record<RunStatus, string> = { success: "Success", failed: "Failed", running: "Running" };

/** Latest runs and web search quota. `now` is injectable for tests. */
export function StatusView({ runs, quota, now = new Date() }: { runs: Run[]; quota: QuotaUsage[]; now?: Date }) {
  const sorted = sortRuns(runs);
  const overview = runOverview(sorted);
  const quotas = quotaRemaining(quota, now);

  return (
    <div className="space-y-6">
      {overview.latest?.status === "failed" && (
        <Notice tone="error" title="The latest run failed">
          {overview.latest.error ?? "No error message was recorded."}
          {overview.lastSuccess && ` Last successful run: ${formatDateTime(overview.lastSuccess.started_at)}.`}
        </Notice>
      )}

      <Card title="Web search quota" description="Free tiers only. When a quota is used up, web search pauses; other sources keep running.">
        <ul className="grid gap-4 sm:grid-cols-3">
          {quotas.map((q) => {
            const empty = q.remaining <= 0;
            const low = !empty && q.usedShare >= 0.8;
            return (
              <li key={q.provider} className="rounded-md border border-neutral-200 p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-semibold">{q.label}</h3>
                  <span className="text-xs text-neutral-500">{q.unit}</span>
                </div>
                <p className="mt-1 text-2xl font-semibold tabular-nums" data-testid={`quota-remaining-${q.provider}`}>
                  {formatQuotaAmount(q.provider, q.remaining)}
                  <span className="ml-1 text-sm font-normal text-neutral-500">left</span>
                </p>
                <div
                  className="mt-2 h-2 rounded-full bg-neutral-100"
                  role="meter"
                  aria-label={`${q.label} quota used`}
                  aria-valuemin={0}
                  aria-valuemax={q.limit}
                  aria-valuenow={q.used}
                >
                  <div
                    className={`h-2 rounded-full ${empty ? "bg-rose-600" : low ? "bg-amber-500" : "bg-sky-700"}`}
                    style={{ width: `${q.usedShare * 100}%` }}
                  />
                </div>
                <p className="mt-1.5 text-xs text-neutral-600">
                  {formatQuotaAmount(q.provider, q.used)} of {formatQuotaAmount(q.provider, q.limit)} used
                  {q.lifetime ? " (one-time, backfill only)" : q.resetsOn ? ` · resets ${formatDate(q.resetsOn)}` : ""}
                  {" · 5% kept in reserve"}
                </p>
                {empty && <p className="mt-1 text-xs font-medium text-rose-700">Used up</p>}
              </li>
            );
          })}
        </ul>
      </Card>

      <Card title="Latest runs" description="Hourly runs cover all profiles; history runs cover yours.">
        {sorted.length === 0 ? (
          <EmptyState title="No runs yet">The first hourly run will show up here.</EmptyState>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead className="text-xs text-neutral-500">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-medium">Started</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Kind</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Duration</th>
                  <th scope="col" className="py-2 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const perSource = perSourceStats(r.stats);
                  return (
                    <tr
                      key={r.id}
                      className={`border-t border-neutral-100 align-top ${r.status === "failed" ? "bg-rose-50/60" : ""}`}
                    >
                      <td className="py-2 pr-3 whitespace-nowrap">
                        <time dateTime={r.started_at}>{formatDateTime(r.started_at)}</time>
                      </td>
                      <td className="py-2 pr-3">{r.kind === "hourly" ? "Hourly" : "History"}</td>
                      <td className="py-2 pr-3">
                        <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[r.status]}`}>
                          {STATUS_TEXT[r.status]}
                        </span>
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap tabular-nums">
                        {formatDuration(r.started_at, r.finished_at) ?? (r.status === "running" ? "In progress" : "—")}
                      </td>
                      <td className="py-2">
                        <p className="tabular-nums">{summarizeStats(r.stats)}</p>
                        {perSource.length > 0 && (
                          <p className="mt-0.5 text-xs text-neutral-500">
                            {perSource.map((p) => `${p.label}: ${p.value}`).join(" · ")}
                          </p>
                        )}
                        {r.error && (
                          <p className="mt-1 font-mono text-xs break-words text-rose-800">
                            <span className="sr-only">Error: </span>
                            {r.error}
                          </p>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

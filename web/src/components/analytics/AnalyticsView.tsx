import Link from "next/link";
import { BarList } from "@/components/charts/BarList";
import { WeeklyChart } from "@/components/charts/WeeklyChart";
import { ReachIndicator } from "@/components/mentions/ReachIndicator";
import { FilterForm } from "@/components/mentions/FilterForm";
import { Card, ComingWithJev, EmptyState } from "@/components/ui";
import { formatDate, formatNumber } from "@/lib/format";
import {
  sourceDistribution,
  topByReach,
  topSourceNames,
  undatedCount,
  weeklyBuckets,
} from "@/lib/queries/analytics";
import { filterMentions, hasActiveFilters, type MentionFilters } from "@/lib/queries/feed";
import { SOURCE_LABELS, type Mention } from "@/lib/types";

/**
 * Analytics for the given mentions. Hidden ("Not relevant") mentions are left
 * out of every number here. `now` is injectable for tests.
 */
export function AnalyticsView({
  mentions,
  filters,
  now,
}: {
  mentions: Mention[];
  filters: Omit<MentionFilters, "showHidden">;
  now?: Date;
}) {
  const shown = filterMentions(mentions, { ...filters, showHidden: false });
  const buckets = weeklyBuckets(shown, { from: filters.from, to: filters.to, now });
  const undated = undatedCount(shown);
  const perSource = sourceDistribution(shown);
  const publishers = topSourceNames(shown, 6);
  const top = topByReach(shown, 5);

  return (
    <div className="space-y-6">
      <FilterForm action="/analytics" values={filters} />

      {shown.length === 0 ? (
        <EmptyState title={hasActiveFilters(filters) ? "No mentions match these filters" : "No mentions yet"}>
          {hasActiveFilters(filters) ? (
            <Link href="/analytics" className="text-sky-700 underline">
              Clear filters
            </Link>
          ) : (
            "Charts appear once the first mentions have been collected."
          )}
        </EmptyState>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Mentions" value={formatNumber(shown.length)} />
            <Stat label="Sources" value={formatNumber(new Set(shown.map((m) => m.source_name)).size)} />
            <Stat label="Weeks shown" value={formatNumber(buckets.length)} />
            <Stat
              label="Busiest week"
              value={formatNumber(Math.max(0, ...buckets.map((b) => b.count)))}
            />
          </dl>

          <Card
            title="Mentions over time"
            description={`Per week (Monday start)${undated ? ` · ${undated} without a publish date not shown` : ""}`}
          >
            <WeeklyChart buckets={buckets} />
          </Card>

          <div className="grid gap-6 md:grid-cols-2">
            <Card title="By source type">
              <BarList
                label="Mentions by source type"
                items={perSource.map((s) => ({ key: s.source, label: s.label, count: s.count, share: s.share }))}
              />
            </Card>
            <Card title="Top publishers">
              <BarList label="Mentions by publisher" items={publishers.map((p) => ({ key: p.name, label: p.name, count: p.count }))} />
            </Card>
          </div>

          <Card title="Top mentions by reach" description="Hidden mentions are excluded.">
            <ol className="divide-y divide-neutral-100">
              {top.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                  <div className="min-w-0 flex-1">
                    <a
                      href={m.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate text-sm font-medium text-neutral-900 hover:underline"
                    >
                      {m.title}
                    </a>
                    <p className="text-xs text-neutral-500">
                      {SOURCE_LABELS[m.source_type]} · {m.source_name} · {formatDate(m.published_at)}
                    </p>
                  </div>
                  <ReachIndicator score={m.reach_score} />
                </li>
              ))}
            </ol>
          </Card>
        </>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <ComingWithJev
          title="Sentiment over time"
          description="Positive, neutral and negative mentions per week, once mentions are classified."
        />
        <ComingWithJev title="Top positive mentions" description="The mentions that help your image the most." />
        <ComingWithJev title="Top negative mentions" description="The mentions that hurt your image the most." />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-4 py-3 shadow-sm">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="mt-0.5 text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

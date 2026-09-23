import Link from "next/link";
import { EmptyState, Notice } from "@/components/ui";
import { formatNumber } from "@/lib/format";
import { PAGE_SIZE, feedSearchString, hasActiveFilters, type FeedParams, type FeedResult } from "@/lib/queries/feed";
import type { BackfillStatus } from "@/lib/types";
import { BackfillNotice } from "./BackfillNotice";
import { FilterForm } from "./FilterForm";
import { MentionCard, type HiddenAction } from "./MentionCard";

/** Everything below the page title on /feed; data comes in as props so it is easy to test. */
export function FeedView({
  params,
  feed,
  backfillStatus,
  truncated,
  hiddenAction,
}: {
  params: FeedParams;
  feed: FeedResult;
  backfillStatus: BackfillStatus;
  truncated: boolean;
  hiddenAction?: HiddenAction;
}) {
  const filtered = hasActiveFilters(params);
  const backfilling = backfillStatus === "pending" || backfillStatus === "running";
  return (
    <div className="space-y-4">
      <BackfillNotice status={backfillStatus} />
      <FilterForm action="/feed" values={params} withSort withHidden />

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-neutral-600">
        <p aria-live="polite">
          {formatNumber(feed.total)} {feed.total === 1 ? "mention" : "mentions"}
          {params.sort === "relevant" ? ", highest reach first" : ", newest first"}
        </p>
        {!params.showHidden && feed.hiddenCount > 0 && (
          <Link href={`/feed${feedSearchString({ ...params, showHidden: true, limit: PAGE_SIZE })}`} className="text-sky-700 hover:underline">
            {feed.hiddenCount} hidden as not relevant — show
          </Link>
        )}
      </div>

      {truncated && (
        <Notice tone="warning" title="Showing the newest mentions only">
          There are more mentions than can be loaded at once. Narrow the date range or sources to see older ones.
        </Notice>
      )}

      {feed.items.length === 0 ? (
        filtered ? (
          <EmptyState title="No mentions match these filters">
            <Link href="/feed" className="text-sky-700 underline">
              Clear filters
            </Link>{" "}
            or try other search words.
          </EmptyState>
        ) : backfilling ? (
          <EmptyState title="No mentions yet">History is being fetched. Results will appear here shortly.</EmptyState>
        ) : (
          <EmptyState title="No mentions yet">
            New mentions are collected every hour. Check your keywords in Settings if nothing shows up.
          </EmptyState>
        )
      ) : (
        <ol className="space-y-3" aria-label="Mentions">
          {feed.items.map((m) => (
            <li key={m.id}>
              <MentionCard mention={m} hiddenAction={hiddenAction} />
            </li>
          ))}
        </ol>
      )}

      {feed.hasMore && (
        <div className="flex justify-center pt-2">
          <Link
            href={`/feed${feedSearchString({ ...params, limit: params.limit + PAGE_SIZE })}`}
            scroll={false}
            className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
          >
            Load more ({formatNumber(feed.total - feed.items.length)} left)
          </Link>
        </div>
      )}
    </div>
  );
}

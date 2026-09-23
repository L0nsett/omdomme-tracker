import { formatDate } from "@/lib/format";
import { SOURCE_LABELS, type Mention } from "@/lib/types";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { ReachIndicator } from "./ReachIndicator";
import { SentimentBadge } from "./SentimentBadge";

export type HiddenAction = (formData: FormData) => void | Promise<void>;

/**
 * One mention in the feed. `hiddenAction` is the Server Action that sets
 * mentions.hidden (passed in so the card has no server-only imports).
 */
export function MentionCard({ mention, hiddenAction }: { mention: Mention; hiddenAction?: HiddenAction }) {
  const m = mention;
  const date = m.published_at ?? m.fetched_at;
  return (
    <article
      aria-labelledby={`mention-${m.id}`}
      className={`rounded-lg border bg-white p-4 shadow-sm transition-colors ${
        m.hidden ? "border-dashed border-neutral-300 bg-neutral-50" : "border-neutral-200"
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500">
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-700">
          {SOURCE_LABELS[m.source_type]}
        </span>
        <span className="truncate">{m.source_name}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={date} title={m.published_at ? "Published" : "Found (no publish date)"}>
          {m.published_at ? formatDate(m.published_at) : `Found ${formatDate(m.fetched_at)}`}
        </time>
        {m.hidden && (
          <span className="rounded bg-neutral-200 px-1.5 py-0.5 font-medium text-neutral-600">Hidden</span>
        )}
      </div>

      <h3 id={`mention-${m.id}`} className="mt-2 text-base leading-snug font-semibold">
        <a
          href={m.url}
          target="_blank"
          rel="noopener noreferrer"
          className={`hover:underline focus-visible:underline ${m.hidden ? "text-neutral-500" : "text-neutral-900"}`}
        >
          {m.title}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </h3>

      {m.snippet ? (
        <p className="mt-1 line-clamp-3 text-sm text-neutral-600">{m.snippet}</p>
      ) : (
        <p className="mt-1 text-sm text-neutral-400 italic">No excerpt available.</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <SentimentBadge sentiment={m.sentiment} confidence={m.confidence} />
        <ReachIndicator score={m.reach_score} />
        {hiddenAction && (
          <form action={hiddenAction} className="ml-auto">
            <input type="hidden" name="id" value={m.id} />
            <input type="hidden" name="hidden" value={m.hidden ? "false" : "true"} />
            <SubmitButton
              pendingLabel="Saving…"
              aria-label={m.hidden ? `Restore "${m.title}"` : `Mark "${m.title}" as not relevant`}
              className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 disabled:opacity-50"
            >
              {m.hidden ? "Restore" : "Not relevant"}
            </SubmitButton>
          </form>
        )}
      </div>
    </article>
  );
}

import { sentimentDisplay, type SentimentTone } from "@/lib/format";
import type { Sentiment } from "@/lib/types";

const TONE_CLASSES: Record<SentimentTone, string> = {
  none: "border-dashed border-neutral-300 text-neutral-500",
  positive: "border-emerald-200 bg-emerald-50 text-emerald-800",
  neutral: "border-neutral-200 bg-neutral-100 text-neutral-700",
  negative: "border-rose-200 bg-rose-50 text-rose-800",
  uncertain: "border-amber-200 bg-amber-50 text-amber-800",
};

/** Sentiment + confidence slot. Shows "Not classified" until Jev fills the fields. */
export function SentimentBadge({ sentiment, confidence }: { sentiment: Sentiment | null; confidence: number | null }) {
  const { label, tone, confidenceText } = sentimentDisplay(sentiment, confidence);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${TONE_CLASSES[tone]}`}
      title={tone === "none" ? "Sentiment classification is coming with Jev" : undefined}
    >
      <span className="sr-only">Sentiment: </span>
      {label}
      {confidenceText && <span className="text-[0.7rem] opacity-80">· {confidenceText}</span>}
    </span>
  );
}

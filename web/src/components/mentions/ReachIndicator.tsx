import { REACH_LEVELS, reachDescription, reachLevel } from "@/lib/format";

/** Five dots, filled by reach score. Screen readers get the words instead. */
export function ReachIndicator({ score }: { score: number }) {
  const level = reachLevel(score);
  const description = reachDescription(score);
  return (
    <span role="img" aria-label={description} title={description} className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="text-xs text-neutral-500">
        Reach
      </span>
      <span aria-hidden="true" className="inline-flex gap-0.5">
        {Array.from({ length: REACH_LEVELS }, (_, i) => (
          <span
            key={i}
            data-filled={i < level}
            className={`h-2 w-2 rounded-full ${i < level ? "bg-sky-700" : "bg-neutral-200"}`}
          />
        ))}
      </span>
    </span>
  );
}

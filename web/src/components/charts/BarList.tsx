/** Horizontal bars with labels and values in text (single series, HTML only). */
export function BarList({
  items,
  label,
}: {
  items: { key: string; label: string; count: number; share?: number }[];
  label: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <ul aria-label={label} className="space-y-2.5">
      {items.map((item) => (
        <li key={item.key} className="text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-neutral-800">{item.label}</span>
            <span className="shrink-0 text-neutral-600 tabular-nums">
              {item.count}
              {item.share !== undefined && (
                <span className="ml-1 text-xs text-neutral-400">({Math.round(item.share * 100)}%)</span>
              )}
            </span>
          </div>
          <div className="mt-1 h-2 rounded-full bg-neutral-100" aria-hidden="true">
            {item.count > 0 && (
              <div className="h-2 rounded-full bg-sky-700" style={{ width: `${(item.count / max) * 100}%` }} />
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

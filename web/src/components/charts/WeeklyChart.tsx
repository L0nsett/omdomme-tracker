import type { WeekBucket } from "@/lib/queries/analytics";

const W = 720;
const H = 220;
const PAD = { top: 12, right: 8, bottom: 28, left: 32 };

const labelFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function weekLabel(weekStart: string): string {
  return labelFormat.format(new Date(`${weekStart}T00:00:00Z`));
}

/** Round the axis max up to a readable number (1, 2, 5, 10, 20, 50 …). */
export function niceMax(n: number): number {
  if (n <= 1) return 1;
  const pow = 10 ** Math.floor(Math.log10(n));
  for (const step of [1, 2, 5, 10]) if (step * pow >= n) return step * pow;
  return 10 * pow;
}

/** Mentions per week as an SVG bar chart (single series), with a table fallback. */
export function WeeklyChart({ buckets }: { buckets: WeekBucket[] }) {
  if (buckets.length === 0) return <p className="text-sm text-neutral-500">No dated mentions in this range.</p>;
  const max = niceMax(Math.max(...buckets.map((b) => b.count)));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const step = plotW / buckets.length;
  const barW = Math.max(1, Math.min(28, step - 2));
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const total = buckets.reduce((s, b) => s + b.count, 0);

  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Bar chart: ${total} mentions over ${buckets.length} weeks, from the week of ${weekLabel(buckets[0].weekStart)}.`}
      >
        {[0, max / 2, max].map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="stroke-neutral-200" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(v)} dy="0.32em" textAnchor="end" className="fill-neutral-500 text-[10px]">
              {Number.isInteger(v) ? v : v.toFixed(1)}
            </text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const x = PAD.left + i * step + (step - barW) / 2;
          const h = (b.count / max) * plotH;
          return (
            <g key={b.weekStart}>
              {/* Invisible full-height hit area so small bars are easy to hover. */}
              <rect x={PAD.left + i * step} y={PAD.top} width={step} height={plotH} fill="transparent">
                <title>{`Week of ${weekLabel(b.weekStart)}: ${b.count} ${b.count === 1 ? "mention" : "mentions"}`}</title>
              </rect>
              {b.count > 0 && (
                <rect x={x} y={y(b.count)} width={barW} height={h} rx={Math.min(3, barW / 2)} className="pointer-events-none fill-sky-700" />
              )}
              {i % labelEvery === 0 && (
                <text x={PAD.left + i * step + step / 2} y={H - 10} textAnchor="middle" className="fill-neutral-500 text-[10px]">
                  {weekLabel(b.weekStart)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <details className="mt-2 text-xs text-neutral-600">
        <summary className="cursor-pointer select-none">Show as table</summary>
        <div className="mt-2 max-h-64 overflow-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="text-neutral-500">
                <th className="py-1 font-medium">Week of</th>
                <th className="py-1 text-right font-medium">Mentions</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.weekStart} className="border-t border-neutral-100">
                  <td className="py-1">{b.weekStart}</td>
                  <td className="py-1 text-right tabular-nums">{b.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

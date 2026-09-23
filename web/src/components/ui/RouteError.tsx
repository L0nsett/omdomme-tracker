"use client";

/** Body for the feed/analytics/status error.tsx boundaries. */
export function RouteError({ what, reset }: { what: string; reset: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-6 text-sm text-rose-900">
      <p className="font-medium">Could not load {what}.</p>
      <p className="mt-1">The database may be waking up. Try again in a moment.</p>
      <button
        type="button"
        onClick={reset}
        className="mt-3 rounded-md border border-rose-300 bg-white px-3 py-1.5 font-medium hover:bg-rose-100"
      >
        Try again
      </button>
    </div>
  );
}

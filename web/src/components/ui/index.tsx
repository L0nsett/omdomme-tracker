import Link from "next/link";

type Tone = "info" | "warning" | "error";

const NOTICE_CLASSES: Record<Tone, string> = {
  info: "border-sky-200 bg-sky-50 text-sky-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  error: "border-rose-200 bg-rose-50 text-rose-900",
};

export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: Tone;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-lg border px-4 py-3 text-sm ${NOTICE_CLASSES[tone]}`}>
      <p className="font-medium">{title}</p>
      {children && <div className="mt-0.5 opacity-90">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-neutral-600">{description}</p>}
      </div>
      {children}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 bg-white px-6 py-10 text-center">
      <p className="font-medium text-neutral-800">{title}</p>
      {children && <div className="mt-1 text-sm text-neutral-600">{children}</div>}
    </div>
  );
}

export function Card({ title, description, children, className = "" }: { title: string; description?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-neutral-200 bg-white p-4 shadow-sm ${className}`}>
      <h2 className="text-sm font-semibold text-neutral-800">{title}</h2>
      {description && <p className="mt-0.5 text-xs text-neutral-500">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** Placeholder for everything that needs sentiment (arrives with Jev, see PLAN.md). */
export function ComingWithJev({ title, description }: { title: string; description: string }) {
  return (
    <section
      aria-label={`${title} (coming with Jev)`}
      className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-neutral-700">{title}</h2>
        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800">Coming with Jev</span>
      </div>
      <p className="mt-2 text-sm text-neutral-500">{description}</p>
    </section>
  );
}

/** Shown when the signed-in user has no profile yet (middleware normally redirects first). */
export function NoProfile() {
  return (
    <EmptyState title="You are not tracking an organization yet">
      <Link href="/onboarding" className="text-sky-700 underline">
        Create a profile or join one with an invite link
      </Link>
      .
    </EmptyState>
  );
}

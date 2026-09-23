import Link from "next/link";

// Shared shell for signed-in pages. Agent C owns auth/redirect logic (middleware),
// agent D owns the pages inside. The sign-out route (/auth/signout) belongs to agent C.
const NAV = [
  { href: "/feed", label: "Feed" },
  { href: "/analytics", label: "Analytics" },
  { href: "/status", label: "Status" },
  { href: "/settings", label: "Settings" },
];

export default function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-neutral-200 bg-white">
        <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="font-semibold">Reputation Tracker</span>
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="text-sm text-neutral-600 hover:text-neutral-900">
              {item.label}
            </Link>
          ))}
          <form action="/auth/signout" method="post" className="ml-auto">
            <button type="submit" className="text-sm text-neutral-600 hover:text-neutral-900">
              Sign out
            </button>
          </form>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}

import type { Metadata } from "next";
import { JoinWithInviteForm } from "@/components/account/join-invite";
import { ProfileForm } from "@/components/account/profile-form";
import { EMPTY_FORM } from "@/lib/auth/profile-form";
import { createClient } from "@/lib/supabase/server";
import { createProfile, joinWithInvite } from "./actions";

export const metadata: Metadata = { title: "Get started · Reputation Tracker" };
export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="min-h-screen">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center gap-4 px-4 py-3">
          <span className="font-semibold">Reputation Tracker</span>
          <span className="ml-auto truncate text-sm text-neutral-500">{user?.email}</span>
          <form action="/auth/signout" method="post">
            <button type="submit" className="text-sm text-neutral-600 hover:text-neutral-900">
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-8 px-4 py-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Set up your profile</h1>
          <p className="mt-1 text-sm text-neutral-600">
            Tell us which organization to track. We start collecting mentions right away, including older ones.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
          <section className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
            <h2 className="mb-4 text-lg font-semibold">Create a new profile</h2>
            <ProfileForm action={createProfile} initial={EMPTY_FORM} submitLabel="Create profile" pendingLabel="Creating profile…" />
          </section>

          <aside className="h-fit rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Joining a team?</h2>
            <p className="mb-4 mt-1 text-sm text-neutral-600">
              If someone already tracks your organization, ask them for an invite link from their Settings page.
            </p>
            <JoinWithInviteForm action={joinWithInvite} />
          </aside>
        </div>
      </main>
    </div>
  );
}

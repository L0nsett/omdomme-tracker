import type { Metadata } from "next";
import Link from "next/link";
import { joinWithInvite } from "@/app/onboarding/actions";
import { AuthCard } from "@/components/account/auth-card";
import { AcceptInviteForm } from "@/components/account/join-invite";
import { parseInviteToken } from "@/lib/auth/profile-form";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Join profile · Reputation Tracker" };
export const dynamic = "force-dynamic";

const linkButton =
  "inline-flex w-full items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700";

/** Invite landing page. The middleware sends signed-out visitors to /login?next=/invite/<token>. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token: rawToken } = await params;
  const token = parseInviteToken(decodeURIComponent(rawToken));
  if (!token) {
    return (
      <AuthCard title="Invalid invite link" subtitle="This link is not a valid invite. Check that you copied all of it.">
        <Link href="/onboarding" className={linkButton}>
          Go to onboarding
        </Link>
      </AuthCard>
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profileId } = await supabase.rpc("my_profile_id");

  if (profileId) {
    // Members can read their own profile's invites (RLS), so this finds invites to their own profile.
    const { data: ownInvite } = await supabase.from("invites").select("id").eq("token", token).maybeSingle();
    return ownInvite ? (
      <AuthCard title="You are already a member" subtitle="This invite is for the profile you already belong to.">
        <Link href="/feed" className={linkButton}>
          Go to your feed
        </Link>
      </AuthCard>
    ) : (
      <AuthCard
        title="You already belong to a profile"
        subtitle="Each account can be a member of one profile. Leave your current profile in Settings before joining another."
      >
        <Link href="/settings" className={linkButton}>
          Open Settings
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Join profile"
      subtitle={
        <>
          You have been invited to track an organization together with its team. You are signed in as{" "}
          <span className="font-medium text-neutral-900">{user?.email}</span>.
        </>
      }
    >
      <div className="space-y-4">
        <AcceptInviteForm action={joinWithInvite} token={token} />
        <p className="text-center text-xs text-neutral-500">
          Invite links work once and expire after 7 days.{" "}
          <Link href="/onboarding" className="underline-offset-2 hover:underline">
            Create your own profile instead
          </Link>
        </p>
      </div>
    </AuthCard>
  );
}

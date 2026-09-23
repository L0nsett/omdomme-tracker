import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CopyButton, InvitePanel } from "@/components/account/invite-panel";
import { LeaveProfile } from "@/components/account/leave-profile";
import { ProfileForm } from "@/components/account/profile-form";
import { formatDate, formatDay } from "@/lib/auth/format";
import { inviteUrl } from "@/lib/auth/origin";
import { profileToFormState } from "@/lib/auth/profile-form";
import { requestOrigin } from "@/lib/auth/request-origin";
import { createClient } from "@/lib/supabase/server";
import type { Invite, KeywordRule, MemberRole, Profile } from "@/lib/types";
import { createInvite, leaveProfile, updateProfile } from "./actions";

export const metadata: Metadata = { title: "Settings · Reputation Tracker" };
export const dynamic = "force-dynamic";

interface MemberRow {
  user_id: string;
  email: string | null;
  role: MemberRole;
  joined_at: string;
}

function Card({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm text-neutral-600">{description}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profileId } = await supabase.rpc("my_profile_id");
  if (!user || !profileId) redirect("/onboarding");

  const nowIso = new Date().toISOString();
  const [profileRes, rulesRes, membersRes, invitesRes, origin] = await Promise.all([
    supabase.from("profiles").select("name, website_url, social_links").eq("id", profileId).single(),
    supabase
      .from("keyword_rules")
      .select("term, context_terms, is_exclusion")
      .eq("profile_id", profileId)
      .order("created_at"),
    supabase.rpc("list_profile_members"),
    supabase
      .from("invites")
      .select("id, token, expires_at")
      .eq("profile_id", profileId)
      .is("used_at", null)
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false }),
    requestOrigin(),
  ]);

  if (profileRes.error || !profileRes.data) {
    return <p className="text-sm text-red-700">Could not load your profile. Please reload the page.</p>;
  }
  const profile = profileRes.data as Pick<Profile, "name" | "website_url" | "social_links">;
  const rules = (rulesRes.data ?? []) as Pick<KeywordRule, "term" | "context_terms" | "is_exclusion">[];
  const members = (membersRes.data ?? []) as MemberRow[];
  const invites = (invitesRes.data ?? []) as Pick<Invite, "id" | "token" | "expires_at">[];
  const me = members.find((m) => m.user_id === user.id);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-neutral-600">Manage the tracked organization and who has access to it.</p>
      </div>

      <Card title="Profile" description="Changes apply to future updates only. Mentions already collected are not re-checked.">
        <ProfileForm
          action={updateProfile}
          initial={profileToFormState(profile, rules)}
          submitLabel="Save changes"
          pendingLabel="Saving…"
          note="Changes apply to future updates only."
        />
      </Card>

      <Card title="Members" description="Everyone here can see the feed and change these settings.">
        {members.length === 0 ? (
          <p className="text-sm text-neutral-500">Could not load members.</p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {members.map((m) => (
              <li key={m.user_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <span className="font-medium">{m.email ?? "Unknown user"}</span>
                {m.user_id === user.id && <span className="text-xs text-neutral-500">(you)</span>}
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${m.role === "owner" ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-700"}`}
                >
                  {m.role === "owner" ? "Owner" : "Member"}
                </span>
                <span className="ml-auto text-xs text-neutral-500">Joined {formatDay(m.joined_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Invite someone" description="Invite links can be used once and expire after 7 days. Anyone with the link can join.">
        <InvitePanel action={createInvite} />
        {invites.length > 0 && (
          <div className="mt-5">
            <h3 className="text-sm font-medium">Unused invite links</h3>
            <ul className="mt-2 space-y-2">
              {invites.map((inv) => {
                const url = inviteUrl(origin, inv.token);
                return (
                  <li key={inv.id} className="flex flex-wrap items-center gap-2 text-xs">
                    <code className="min-w-0 flex-1 truncate rounded bg-neutral-100 px-2 py-1">{url}</code>
                    <span className="text-neutral-500">expires {formatDate(inv.expires_at)}</span>
                    <CopyButton text={url} />
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Card>

      <Card title="Leave profile" description="Stop tracking this organization with your account.">
        <LeaveProfile action={leaveProfile} isLastMember={members.length <= 1} isOwner={me?.role === "owner"} />
      </Card>
    </div>
  );
}

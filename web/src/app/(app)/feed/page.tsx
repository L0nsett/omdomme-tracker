import type { Metadata } from "next";
import { FeedView } from "@/components/mentions/FeedView";
import { NoProfile, PageHeader } from "@/components/ui";
import { fetchMentions, fetchMyProfile } from "@/lib/queries/db";
import { buildFeed, parseFeedParams, type SearchParams } from "@/lib/queries/feed";
import { createClient } from "@/lib/supabase/server";
import { setMentionHidden } from "./actions";

export const metadata: Metadata = { title: "Feed · Reputation Tracker" };

export default async function FeedPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = parseFeedParams(await searchParams);
  const supabase = await createClient();
  const profile = await fetchMyProfile(supabase);
  if (!profile) return <NoProfile />;

  // Hidden rows are always loaded so the page can say how many are hidden.
  const { rows, truncated } = await fetchMentions(supabase, profile.id, {
    sources: params.sources,
    from: params.from,
    to: params.to,
    includeHidden: true,
  });
  const feed = buildFeed(rows, params);

  return (
    <>
      <PageHeader title="Feed" description={`Everything the web says about ${profile.name}.`} />
      <FeedView
        params={params}
        feed={feed}
        backfillStatus={profile.backfill_status}
        truncated={truncated}
        hiddenAction={setMentionHidden}
      />
    </>
  );
}

import type { Metadata } from "next";
import { AnalyticsView } from "@/components/analytics/AnalyticsView";
import { Notice, NoProfile, PageHeader } from "@/components/ui";
import { fetchMentions, fetchMyProfile } from "@/lib/queries/db";
import { parseFilterParams, type SearchParams } from "@/lib/queries/feed";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Analytics · Reputation Tracker" };

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const filters = parseFilterParams(await searchParams);
  const supabase = await createClient();
  const profile = await fetchMyProfile(supabase);
  if (!profile) return <NoProfile />;

  const { rows, truncated } = await fetchMentions(supabase, profile.id, {
    sources: filters.sources,
    from: filters.from,
    to: filters.to,
    includeHidden: false,
  });

  return (
    <>
      <PageHeader title="Analytics" description={`How ${profile.name} is covered, week by week.`} />
      {truncated && (
        <div className="mb-4">
          <Notice tone="warning" title="Based on the newest mentions only">
            Narrow the date range to include older mentions.
          </Notice>
        </div>
      )}
      <AnalyticsView mentions={rows} filters={filters} />
    </>
  );
}

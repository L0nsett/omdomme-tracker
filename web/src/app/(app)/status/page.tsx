import type { Metadata } from "next";
import { StatusView } from "@/components/status/StatusView";
import { PageHeader } from "@/components/ui";
import { fetchQuotaUsage, fetchRuns } from "@/lib/queries/db";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Status · Reputation Tracker" };

export default async function StatusPage() {
  const supabase = await createClient();
  const [runs, quota] = await Promise.all([fetchRuns(supabase, 20), fetchQuotaUsage(supabase)]);
  return (
    <>
      <PageHeader title="Status" description="Data collection runs and remaining web search quota." />
      <StatusView runs={runs} quota={quota} />
    </>
  );
}

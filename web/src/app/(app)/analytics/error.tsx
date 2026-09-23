"use client";

import { RouteError } from "@/components/ui/RouteError";

export default function AnalyticsError({ reset }: { error: Error; reset: () => void }) {
  return <RouteError what="analytics" reset={reset} />;
}

"use client";

import { RouteError } from "@/components/ui/RouteError";

export default function FeedError({ reset }: { error: Error; reset: () => void }) {
  return <RouteError what="the feed" reset={reset} />;
}
